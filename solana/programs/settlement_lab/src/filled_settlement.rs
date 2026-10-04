//! Operator-attested Filled settlement with atomic legacy SPL operations.
//! Canonical hashes bind content; this instruction does not prove EVM execution.

use crate::{
    accounting::{Accounting, AccountingError, FillAccountingError},
    configuration::{Config, InitializationError as FilledError},
    filled_receipt::{validate_filled_receipt, FilledDecision, FilledReceiptError},
    order_state::{Order, OrderState, UserNonce},
    protocol_encoding::{Domain, Identity, Receipt, Terms},
};
use anchor_lang::{prelude::*, solana_program::program::invoke_signed};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::{
        self, spl_token, spl_token::state::AccountState, Mint, Token, TokenAccount, TransferChecked,
    },
};

/// Borsh transport adapter only; canonical hashing uses protocol_encoding.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FilledDomainArgs {
    pub source_domain: [u8; 32],
    pub destination_domain: [u8; 32],
    pub solana_program: Pubkey,
    pub chain_id: [u8; 32],
    pub settlement: [u8; 20],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FilledTermsArgs {
    pub domain: FilledDomainArgs,
    pub user: Pubkey,
    pub nonce: u64,
    pub market: [u8; 32],
    pub outcome: u8,
    pub cash_amount: u64,
    pub minimum_shares: u64,
}

impl FilledTermsArgs {
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
pub struct FilledReceiptArgs {
    pub terms_hash: [u8; 32],
    pub terminal: u8,
    pub filled_quantity: u64,
}

impl FilledReceiptArgs {
    fn canonical(&self) -> Receipt {
        Receipt {
            terms_hash: self.terms_hash,
            terminal: self.terminal,
            filled_quantity: self.filled_quantity,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AcceptFilledArgs {
    pub terms: FilledTermsArgs,
    pub receipt: FilledReceiptArgs,
}

#[derive(Accounts)]
#[instruction(args: AcceptFilledArgs)]
pub struct AcceptFilled<'info> {
    #[account(address = config.solana_operator @ FilledError::FilledUnauthorizedOperator)]
    pub operator: Signer<'info>,
    /// CHECK: Readonly original identity, authenticated by permanent records and canonical seeds.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump,
        constraint = config.bump == Pubkey::find_program_address(&[b"config"], &crate::ID).1 @ FilledError::FilledInvalidBinding)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"accounting", config.key().as_ref()], bump,
        constraint = accounting.config == config.key() && accounting.bump == Pubkey::find_program_address(&[b"accounting", config.key().as_ref()], &crate::ID).1 @ FilledError::FilledInvalidBinding)]
    pub accounting: Box<Account<'info, Accounting>>,
    #[account(seeds = [b"user", config.key().as_ref(), user.key().as_ref()], bump)]
    pub user_nonce: Box<Account<'info, UserNonce>>,
    #[account(mut, seeds = [b"order", config.key().as_ref(), user.key().as_ref(), &args.terms.nonce.to_be_bytes()], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(address = config.cash_mint @ FilledError::FilledInvalidBinding)]
    pub cash_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.yes_mint @ FilledError::FilledInvalidBinding)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"escrow", order.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.executor_cash_ata @ FilledError::FilledInvalidBinding)]
    pub executor_cash_ata: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"yes-authority", config.key().as_ref()], bump)]
    /// CHECK: Only the canonical PDA address and bump are required for CPI signing.
    pub yes_authority: UncheckedAccount<'info>,
    #[account(address = config.token_program @ FilledError::FilledInvalidBinding)]
    pub token_program: Program<'info, Token>,
}

pub fn accept_filled(ctx: Context<AcceptFilled>, args: AcceptFilledArgs) -> Result<()> {
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
        FilledError::FilledInvalidConfig
    );

    require!(
        a.user.key() != c.solana_operator && a.user.key() != c.solana_executor,
        FilledError::FilledReservedUser
    );
    let keys = [
        a.operator.key(),
        a.user.key(),
        c.key(),
        a.accounting.key(),
        a.user_nonce.key(),
        a.order.key(),
        a.cash_mint.key(),
        a.yes_mint.key(),
        a.user_yes_ata.key(),
        a.escrow.key(),
        a.executor_cash_ata.key(),
        a.yes_authority.key(),
        a.token_program.key(),
    ];
    for (index, key) in keys.iter().enumerate() {
        require!(!keys[..index].contains(key), FilledError::FilledUnsafeAlias);
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
            && o.user_cash_ata
                == get_associated_token_address_with_program_id(
                    &o.user,
                    &c.cash_mint,
                    &Token::id()
                )
            && o.user_yes_ata == a.user_yes_ata.key()
            && o.user_yes_ata
                == get_associated_token_address_with_program_id(&o.user, &c.yes_mint, &Token::id())
            && c.yes_mint_authority == a.yes_authority.key()
            && c.yes_authority_bump == ctx.bumps.yes_authority,
        FilledError::FilledInvalidBinding
    );
    require!(
        a.cash_mint.is_initialized
            && a.yes_mint.is_initialized
            && a.cash_mint.decimals == 6
            && a.yes_mint.decimals == 6
            && a.cash_mint.freeze_authority.is_none()
            && a.yes_mint.freeze_authority.is_none()
            && a.yes_mint.mint_authority == Some(yes_authority).into(),
        FilledError::FilledInvalidMint
    );
    require!(
        a.user_yes_ata.owner == o.user
            && a.user_yes_ata.mint == c.yes_mint
            && a.user_yes_ata.state == AccountState::Initialized,
        FilledError::FilledUnsafeToken
    );
    require!(
        a.escrow.mint == c.cash_mint
            && a.escrow.owner == o.key()
            && a.escrow.state == AccountState::Initialized
            && a.escrow.delegate.is_none()
            && a.escrow.close_authority.is_none(),
        FilledError::FilledUnsafeToken
    );
    require!(
        a.executor_cash_ata.owner == c.solana_executor
            && a.executor_cash_ata.mint == c.cash_mint
            && a.executor_cash_ata.key()
                == get_associated_token_address_with_program_id(
                    &c.solana_executor,
                    &c.cash_mint,
                    &Token::id()
                )
            && a.executor_cash_ata.state == AccountState::Initialized
            && a.executor_cash_ata.delegate.is_none()
            && a.executor_cash_ata.close_authority.is_none(),
        FilledError::FilledUnsafeToken
    );

    let accepted = match validate_filled_receipt(
        c.key(),
        c,
        o,
        &args.terms.canonical(),
        &args.receipt.canonical(),
    )
    .map_err(receipt_error)?
    {
        FilledDecision::Replay => return Ok(()),
        FilledDecision::Apply(accepted) => accepted,
    };
    // Replay bypasses all capacity checks, accounting, CPIs, and mutations.
    let cash = o.cash_amount;
    let quantity = accepted.filled_quantity;
    let supply_before = a.yes_mint.supply;
    let yes_before = a.user_yes_ata.amount;
    let escrow_before = a.escrow.amount;
    let executor_before = a.executor_cash_ata.amount;
    a.accounting
        .record_fill(cash, quantity)
        .map_err(fill_accounting_error)?;

    // anchor-spl's legacy module has no checked-mint wrapper. Construct the
    // legacy MintToChecked instruction explicitly using its pinned re-export.
    let mint_ix = spl_token::instruction::mint_to_checked(
        &Token::id(),
        &a.yes_mint.key(),
        &a.user_yes_ata.key(),
        &a.yes_authority.key(),
        &[],
        quantity,
        6,
    )?;
    let config_key = c.key();
    let authority_bump = [ctx.bumps.yes_authority];
    invoke_signed(
        &mint_ix,
        &[
            a.yes_mint.to_account_info(),
            a.user_yes_ata.to_account_info(),
            a.yes_authority.to_account_info(),
        ],
        &[&[b"yes-authority", config_key.as_ref(), &authority_bump]],
    )?;

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
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.escrow.to_account_info(),
                mint: a.cash_mint.to_account_info(),
                to: a.executor_cash_ata.to_account_info(),
                authority: a.order.to_account_info(),
            },
            &[order_seeds],
        ),
        cash,
        6,
    )?;
    a.yes_mint.reload()?;
    a.user_yes_ata.reload()?;
    a.escrow.reload()?;
    a.executor_cash_ata.reload()?;
    require!(
        supply_before.checked_add(quantity) == Some(a.yes_mint.supply)
            && yes_before.checked_add(quantity) == Some(a.user_yes_ata.amount)
            && escrow_before.checked_sub(cash) == Some(a.escrow.amount)
            && executor_before.checked_add(cash) == Some(a.executor_cash_ata.amount),
        FilledError::FilledUnexpectedBalance
    );
    a.order.state = OrderState::Settled;
    a.order.accepted_receipt = Some(accepted);
    emit!(FilledAccepted {
        order: a.order.key(),
        terms_hash: a.order.terms_hash,
        receipt_hash: accepted.receipt_hash,
        cash_amount: cash,
        filled_quantity: quantity
    });
    Ok(())
}

fn receipt_error(error: FilledReceiptError) -> anchor_lang::error::Error {
    use FilledReceiptError::*;
    match error {
        ReceiptTermsHashMismatch
        | InvalidFilledTerminal(_)
        | InvalidFilledQuantity { .. }
        | MinimumNotMet => error!(FilledError::FilledInvalidReceipt),
        InconsistentRecord | TerminalConflict => error!(FilledError::FilledInconsistentRecord),
        _ => error!(FilledError::FilledTermsConflict),
    }
}

fn fill_accounting_error(error: FillAccountingError) -> anchor_lang::error::Error {
    match error {
        FillAccountingError::Accounting(AccountingError::ArithmeticOverflow) => {
            error!(FilledError::AccountingArithmeticOverflow)
        }
        FillAccountingError::Accounting(AccountingError::PayoutsExceedDeposits) => {
            error!(FilledError::AccountingPayoutsExceedDeposits)
        }
        _ => error!(FilledError::FilledInvalidReceipt),
    }
}

#[event]
pub struct FilledAccepted {
    pub order: Pubkey,
    pub terms_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub cash_amount: u64,
    pub filled_quantity: u64,
}
