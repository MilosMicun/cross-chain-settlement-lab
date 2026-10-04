//! Operator-attested Cancelled settlement with atomic legacy SPL refunds.
//!
//! The configured operator attests the destination terminal outcome. Canonical
//! hashes bind content; this instruction does not prove EVM cancellation or
//! finality. Prior user cancellation alone cannot release escrow, nor can a
//! timeout, venue failure, or missing acknowledgement. Permanent terminal records
//! prevent another refund through exact replay.

use crate::{
    accounting::{Accounting, AccountingError},
    cancelled_receipt::{validate_cancelled_receipt, CancelledDecision, CancelledReceiptError},
    configuration::{Config, InitializationError as RefundError},
    order_state::{Order, OrderState, UserNonce},
    protocol_encoding::{Domain, Identity, Receipt, Terms},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::{self, spl_token::state::AccountState, Mint, Token, TokenAccount, TransferChecked},
};

/// Borsh transport adapter only; canonical hashing uses protocol_encoding.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CancelledDomainArgs {
    pub source_domain: [u8; 32],
    pub destination_domain: [u8; 32],
    pub solana_program: Pubkey,
    pub chain_id: [u8; 32],
    pub settlement: [u8; 20],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CancelledTermsArgs {
    pub domain: CancelledDomainArgs,
    pub user: Pubkey,
    pub nonce: u64,
    pub market: [u8; 32],
    pub outcome: u8,
    pub cash_amount: u64,
    pub minimum_shares: u64,
}

impl CancelledTermsArgs {
    fn canonical(&self) -> Terms {
        Terms {
            identity: Identity {
                domain: Domain {
                    source_domain: self.domain.source_domain,
                    destination_domain: self.domain.destination_domain,
                    solana_program: self.domain.solana_program.to_bytes(),
                    chain_id: self.domain.chain_id,
                    settlement: self.domain.settlement,
                },
                user: self.user.to_bytes(),
                nonce: self.nonce,
            },
            market: self.market,
            outcome: self.outcome,
            cash_amount: self.cash_amount,
            minimum_shares: self.minimum_shares,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CancelledReceiptArgs {
    pub terms_hash: [u8; 32],
    pub terminal: u8,
    pub filled_quantity: u64,
}

impl CancelledReceiptArgs {
    fn canonical(&self) -> Receipt {
        Receipt {
            terms_hash: self.terms_hash,
            terminal: self.terminal,
            filled_quantity: self.filled_quantity,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AcceptCancelledArgs {
    pub terms: CancelledTermsArgs,
    pub receipt: CancelledReceiptArgs,
}

#[derive(Accounts)]
#[instruction(args: AcceptCancelledArgs)]
pub struct AcceptCancelled<'info> {
    #[account(address = config.solana_operator @ RefundError::RefundUnauthorizedOperator)]
    pub operator: Signer<'info>,
    /// CHECK: Readonly original identity, authenticated by permanent records and canonical seeds.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump,
        constraint = config.bump == Pubkey::find_program_address(&[b"config"], &crate::ID).1 @ RefundError::RefundInvalidBinding)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"accounting", config.key().as_ref()], bump,
        constraint = accounting.config == config.key() && accounting.bump == Pubkey::find_program_address(&[b"accounting", config.key().as_ref()], &crate::ID).1 @ RefundError::RefundInvalidBinding)]
    pub accounting: Box<Account<'info, Accounting>>,
    #[account(seeds = [b"user", config.key().as_ref(), user.key().as_ref()], bump)]
    pub user_nonce: Box<Account<'info, UserNonce>>,
    #[account(mut, seeds = [b"order", config.key().as_ref(), user.key().as_ref(), &args.terms.nonce.to_be_bytes()], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(address = config.cash_mint @ RefundError::RefundInvalidBinding)]
    pub cash_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub user_cash_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"escrow", order.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(address = config.token_program @ RefundError::RefundInvalidBinding)]
    pub token_program: Program<'info, Token>,
}

pub fn accept_cancelled(ctx: Context<AcceptCancelled>, args: AcceptCancelledArgs) -> Result<()> {
    let a = ctx.accounts;
    let c = &a.config;
    let (yes_authority, yes_bump) =
        Pubkey::find_program_address(&[b"yes-authority", c.key().as_ref()], &crate::ID);
    require!(
        c.version == 1
            && c.outcome == 0
            && c.solana_program == crate::ID
            && c.source_domain != [0; 32]
            && c.destination_domain != [0; 32]
            && c.source_domain != c.destination_domain
            && c.chain_id != [0; 32]
            && c.market != [0; 32]
            && [
                c.settlement,
                c.venue,
                c.cash_token,
                c.yes_token,
                c.evm_operator,
                c.evm_executor
            ]
            .iter()
            .all(|address| *address != [0; 20])
            && c.cash_token != c.yes_token
            && c.evm_operator != c.evm_executor
            && c.solana_operator != Pubkey::default()
            && c.solana_executor != Pubkey::default()
            && c.solana_operator != c.solana_executor
            && c.cash_mint != c.yes_mint
            && c.yes_mint_authority == yes_authority
            && c.yes_authority_bump == yes_bump
            && c.token_program == Token::id()
            && c.associated_token_program == AssociatedToken::id()
            && c.system_program == System::id()
            && c.executor_cash_ata
                == get_associated_token_address_with_program_id(
                    &c.solana_executor,
                    &c.cash_mint,
                    &Token::id()
                ),
        RefundError::RefundInvalidConfig
    );
    require!(
        a.user.key() != c.solana_operator && a.user.key() != c.solana_executor,
        RefundError::RefundReservedUser
    );
    let keys = [
        a.operator.key(),
        a.user.key(),
        c.key(),
        a.accounting.key(),
        a.user_nonce.key(),
        a.order.key(),
        a.cash_mint.key(),
        a.user_cash_ata.key(),
        a.escrow.key(),
        a.token_program.key(),
    ];
    for (index, key) in keys.iter().enumerate() {
        require!(!keys[..index].contains(key), RefundError::RefundUnsafeAlias);
    }
    let o = &a.order;
    require!(
        a.user_nonce.config == c.key()
            && a.user_nonce.user == a.user.key()
            && a.user_nonce.bump == ctx.bumps.user_nonce
            && a.user_nonce.next_nonce > o.nonce
            && o.config == c.key()
            && o.user == a.user.key()
            && o.nonce == args.terms.nonce
            && o.bump == ctx.bumps.order
            && o.escrow == a.escrow.key()
            && o.escrow_bump == ctx.bumps.escrow
            && o.user_cash_ata == a.user_cash_ata.key()
            && o.user_cash_ata
                == get_associated_token_address_with_program_id(
                    &o.user,
                    &c.cash_mint,
                    &Token::id()
                )
            && o.user_yes_ata
                == get_associated_token_address_with_program_id(&o.user, &c.yes_mint, &Token::id()),
        RefundError::RefundInvalidBinding
    );
    // Refund needs only the stored canonical YES address, never a live YES ATA/mint.
    require!(
        a.cash_mint.is_initialized
            && a.cash_mint.decimals == 6
            && a.cash_mint.freeze_authority.is_none(),
        RefundError::RefundInvalidMint
    );
    // Match creation policy: user ATAs may retain delegates/close authorities.
    require!(
        a.user_cash_ata.owner == o.user
            && a.user_cash_ata.mint == c.cash_mint
            && a.user_cash_ata.state == AccountState::Initialized,
        RefundError::RefundUnsafeToken
    );
    require!(
        a.escrow.mint == c.cash_mint
            && a.escrow.owner == o.key()
            && a.escrow.state == AccountState::Initialized
            && a.escrow.delegate.is_none()
            && a.escrow.close_authority.is_none(),
        RefundError::RefundUnsafeToken
    );

    let accepted = match validate_cancelled_receipt(
        c.key(),
        c,
        o,
        &args.terms.canonical(),
        &args.receipt.canonical(),
    )
    .map_err(receipt_error)?
    {
        CancelledDecision::Replay => return Ok(()),
        CancelledDecision::Apply(accepted) => accepted,
    };
    // Replay bypasses balance capacity, accounting, CPIs, events, and mutations;
    // an initialized empty escrow remains a valid account for exact replay.
    let cash = o.cash_amount;
    let escrow_before = a.escrow.amount;
    let user_before = a.user_cash_ata.amount;
    a.accounting
        .record_refund(cash)
        .map_err(refund_accounting_error)?;

    let config_key = c.key();
    let user_key = a.user.key();
    let nonce = a.order.nonce.to_be_bytes();
    let order_bump = [ctx.bumps.order];
    let order_seeds: &[&[u8]] = &[
        b"order",
        config_key.as_ref(),
        user_key.as_ref(),
        &nonce,
        &order_bump,
    ];
    // All failures propagate: accounting, CPI, and persistence are one transaction.
    // Transfer only the order deposit; unsolicited escrow donations stay locked.
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.escrow.to_account_info(),
                mint: a.cash_mint.to_account_info(),
                to: a.user_cash_ata.to_account_info(),
                authority: a.order.to_account_info(),
            },
            &[order_seeds],
        ),
        cash,
        6,
    )?;
    a.escrow.reload()?;
    a.user_cash_ata.reload()?;
    require!(
        escrow_before.checked_sub(cash) == Some(a.escrow.amount)
            && user_before.checked_add(cash) == Some(a.user_cash_ata.amount),
        RefundError::RefundUnexpectedBalance
    );
    a.order.state = OrderState::Refunded;
    a.order.accepted_receipt = Some(accepted);
    emit!(CancelledAccepted {
        order: a.order.key(),
        terms_hash: a.order.terms_hash,
        receipt_hash: accepted.receipt_hash,
        cash_amount: cash,
    });
    Ok(())
}

fn receipt_error(error: CancelledReceiptError) -> anchor_lang::error::Error {
    use CancelledReceiptError::*;
    match error {
        UnsupportedConfigVersion(_) => error!(RefundError::RefundInvalidConfig),
        ConfigMismatch => error!(RefundError::RefundInvalidBinding),
        MarketOutcomeMismatch
        | InvalidStoredOrderId
        | InvalidStoredTermsHash
        | InconsistentRecord => {
            error!(RefundError::RefundInconsistentRecord)
        }
        InvalidStoredAmounts(_) => error!(RefundError::RefundInvalidAmount),
        TermsMismatch => error!(RefundError::RefundTermsConflict),
        ReceiptTermsHashMismatch | InvalidCancelledTerminal(_) | NonzeroCancelledQuantity(_) => {
            error!(RefundError::RefundInvalidReceipt)
        }
        CancellationNotRequested => error!(RefundError::RefundCancellationNotRequested),
        TerminalConflict => error!(RefundError::RefundTerminalConflict),
    }
}

fn refund_accounting_error(error: AccountingError) -> anchor_lang::error::Error {
    match error {
        AccountingError::InvalidAmount(_) => error!(RefundError::RefundInvalidAmount),
        AccountingError::ArithmeticOverflow => error!(RefundError::AccountingArithmeticOverflow),
        AccountingError::PayoutsExceedDeposits => {
            error!(RefundError::AccountingPayoutsExceedDeposits)
        }
    }
}

#[event]
pub struct CancelledAccepted {
    pub order: Pubkey,
    pub terms_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub cash_amount: u64,
}
