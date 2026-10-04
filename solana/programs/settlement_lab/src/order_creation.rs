//! Atomic cash deposits and permanent order identities. No terminal processing.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::{self, spl_token::state::AccountState, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{
    accounting::{Accounting, AccountingError},
    configuration::Config,
    order_state::{
        checked_next_nonce, validate_amounts, Order, OrderState, UserNonce, ValidationError,
    },
    protocol_encoding::{order_id, terms_hash},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateOrderArgs {
    pub nonce: u64,
    pub cash_amount: u64,
    pub minimum_shares: u64,
}

#[derive(Accounts)]
#[instruction(args: CreateOrderArgs)]
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump, constraint = config.bump == Pubkey::find_program_address(&[b"config"], &crate::ID).1 @ CreationError::InvalidBinding)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"accounting", config.key().as_ref()], bump,
        constraint = accounting.config == config.key() @ CreationError::AccountingInvalidBinding,
        constraint = accounting.bump == Pubkey::find_program_address(&[b"accounting", config.key().as_ref()], &crate::ID).1 @ CreationError::AccountingInvalidBinding)]
    pub accounting: Box<Account<'info, Accounting>>,
    #[account(init_if_needed, payer = user, space = 8 + UserNonce::INIT_SPACE,
        seeds = [b"user", config.key().as_ref(), user.key().as_ref()], bump)]
    pub user_nonce: Box<Account<'info, UserNonce>>,
    #[account(init_if_needed, payer = user, space = 8 + Order::INIT_SPACE,
        seeds = [b"order", config.key().as_ref(), user.key().as_ref(), &args.nonce.to_be_bytes()], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(address = config.cash_mint @ CreationError::InvalidBinding)]
    pub cash_mint: Box<Account<'info, Mint>>,
    #[account(address = config.yes_mint @ CreationError::InvalidBinding)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub user_cash_ata: Box<Account<'info, TokenAccount>>,
    pub user_yes_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, seeds = [b"escrow", order.key().as_ref()], bump,
        space = TokenAccount::LEN, owner = token_program.key())]
    /// CHECK: Canonical seeds, size, and legacy owner are constrained above;
    /// initialized SPL data and all token relationships are validated below.
    pub escrow: UncheckedAccount<'info>,
    #[account(address = config.token_program @ CreationError::InvalidBinding)]
    pub token_program: Program<'info, Token>,
    #[account(address = config.associated_token_program @ CreationError::InvalidBinding)]
    pub associated_token_program: Program<'info, AssociatedToken>,
    #[account(address = config.system_program @ CreationError::InvalidBinding)]
    pub system_program: Program<'info, System>,
}

pub fn create_order(ctx: Context<CreateOrder>, args: CreateOrderArgs) -> Result<()> {
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
        CreationError::InvalidConfig
    );
    require!(
        a.user.key() != c.solana_operator && a.user.key() != c.solana_executor,
        CreationError::ReservedUser
    );
    let keys = [
        a.user.key(),
        c.key(),
        a.accounting.key(),
        a.user_nonce.key(),
        a.order.key(),
        a.cash_mint.key(),
        a.yes_mint.key(),
        a.user_cash_ata.key(),
        a.user_yes_ata.key(),
        a.escrow.key(),
        a.token_program.key(),
        a.associated_token_program.key(),
        a.system_program.key(),
    ];
    for (index, key) in keys.iter().enumerate() {
        require!(!keys[..index].contains(key), CreationError::UnsafeAlias);
    }
    require!(
        a.cash_mint.is_initialized
            && a.yes_mint.is_initialized
            && a.cash_mint.decimals == 6
            && a.yes_mint.decimals == 6
            && a.cash_mint.freeze_authority.is_none()
            && a.yes_mint.freeze_authority.is_none()
            && a.yes_mint.mint_authority == Some(yes_authority).into(),
        CreationError::InvalidMint
    );
    // YES supply is deliberately unrestricted after initialization.
    for (account, mint) in [
        (&a.user_cash_ata, c.cash_mint),
        (&a.user_yes_ata, c.yes_mint),
    ] {
        require!(
            account.owner == a.user.key() && account.mint == mint,
            CreationError::InvalidUserToken
        );
        require_keys_eq!(
            account.key(),
            get_associated_token_address_with_program_id(&a.user.key(), &mint, &Token::id()),
            CreationError::NoncanonicalAta
        );
        require!(
            account.state == AccountState::Initialized,
            CreationError::UnsafeTokenState
        );
    }
    validate_amounts(args.cash_amount, args.minimum_shares).map_err(creation_validation_error)?;

    // Only freshly initialized, zero-filled records have a default config. There
    // is no instruction that closes, resets, assigns, or clears these records.
    let new_counter = a.user_nonce.config == Pubkey::default();
    if !new_counter {
        require!(
            a.user_nonce.config == c.key()
                && a.user_nonce.user == a.user.key()
                && a.user_nonce.bump == ctx.bumps.user_nonce,
            CreationError::InvalidBinding
        );
    } else {
        require!(
            a.user_nonce.user == Pubkey::default()
                && a.user_nonce.next_nonce == 0
                && a.user_nonce.bump == 0,
            CreationError::InvalidBinding
        );
    }
    let is_new = a.order.config == Pubkey::default();
    // Generic allocation avoids Anchor's token-interface init code. A zero-filled
    // SPL-owned allocation can only be initialized on the NEW-order path. A
    // replay with a missing/uninitialized escrow fails and rolls allocation back.
    let escrow_uninitialized = a.escrow.try_borrow_data()?.iter().all(|byte| *byte == 0);
    if is_new && escrow_uninitialized {
        token::initialize_account3(CpiContext::new(
            a.token_program.key(),
            token::InitializeAccount3 {
                account: a.escrow.to_account_info(),
                mint: a.cash_mint.to_account_info(),
                authority: a.order.to_account_info(),
            },
        ))?;
    }
    let escrow = read_escrow(&a.escrow)?;
    require!(
        escrow.mint == c.cash_mint
            && escrow.owner == a.order.key()
            && escrow.state == AccountState::Initialized
            && escrow.delegate.is_none()
            && escrow.close_authority.is_none(),
        CreationError::UnsafeEscrow
    );
    if !is_new {
        let o = &a.order;
        require!(
            !new_counter
                && a.user_nonce.next_nonce > o.nonce
                && o.config == c.key()
                && o.user == a.user.key()
                && o.nonce == args.nonce
                && o.market == c.market
                && o.outcome == c.outcome
                && o.user_cash_ata == a.user_cash_ata.key()
                && o.user_yes_ata == a.user_yes_ata.key()
                && o.escrow == a.escrow.key()
                && o.bump == ctx.bumps.order
                && o.escrow_bump == ctx.bumps.escrow,
            CreationError::InvalidBinding
        );
        let stored_terms = o.terms(c);
        require!(
            o.cash_amount == args.cash_amount
                && o.minimum_shares == args.minimum_shares
                && o.order_id == order_id(&stored_terms.identity)
                && o.terms_hash == terms_hash(&stored_terms),
            CreationError::TermsConflict
        );
        // Lifecycle, escrow amount, and available user cash do not govern replay.
        return Ok(());
    }
    let next_nonce = checked_next_nonce(a.user_nonce.next_nonce, args.nonce)
        .map_err(creation_validation_error)?;
    let user_before = a.user_cash_ata.amount;
    let escrow_before = escrow.amount;
    // Replay returns above. This checked update and all subsequent token/state
    // operations roll back together if any part of NEW creation fails.
    a.accounting
        .record_deposit(args.cash_amount)
        .map_err(accounting_error)?;
    token::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.user_cash_ata.to_account_info(),
                mint: a.cash_mint.to_account_info(),
                to: a.escrow.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        args.cash_amount,
        a.cash_mint.decimals,
    )?;
    a.user_cash_ata.reload()?;
    let escrow_after = read_escrow(&a.escrow)?;
    require!(
        user_before.checked_sub(args.cash_amount) == Some(a.user_cash_ata.amount)
            && escrow_before.checked_add(args.cash_amount) == Some(escrow_after.amount),
        CreationError::UnexpectedBalance
    );

    a.order.set_inner(Order {
        config: c.key(),
        user: a.user.key(),
        nonce: args.nonce,
        market: c.market,
        outcome: c.outcome,
        cash_amount: args.cash_amount,
        minimum_shares: args.minimum_shares,
        order_id: [0; 32],
        terms_hash: [0; 32],
        user_cash_ata: a.user_cash_ata.key(),
        user_yes_ata: a.user_yes_ata.key(),
        escrow: a.escrow.key(),
        state: OrderState::Pending,
        cancellation_requested: false,
        accepted_receipt: None,
        bump: ctx.bumps.order,
        escrow_bump: ctx.bumps.escrow,
    });
    let terms = a.order.terms(c);
    a.order.order_id = order_id(&terms.identity);
    a.order.terms_hash = terms_hash(&terms);
    a.user_nonce.set_inner(UserNonce {
        config: c.key(),
        user: a.user.key(),
        next_nonce,
        bump: ctx.bumps.user_nonce,
    });
    emit!(OrderCreated {
        config: c.key(),
        user: a.user.key(),
        nonce: args.nonce,
        order: a.order.key(),
        order_id: a.order.order_id,
        terms_hash: a.order.terms_hash,
        market: c.market,
        outcome: c.outcome,
        cash_amount: args.cash_amount,
        minimum_shares: args.minimum_shares,
        user_cash_ata: a.user_cash_ata.key(),
        user_yes_ata: a.user_yes_ata.key(),
        escrow: a.escrow.key(),
    });
    Ok(())
}

fn read_escrow(account: &UncheckedAccount<'_>) -> Result<TokenAccount> {
    TokenAccount::try_deserialize(&mut account.try_borrow_data()?.as_ref())
}

fn creation_validation_error(error: ValidationError) -> anchor_lang::error::Error {
    match error {
        ValidationError::ZeroCash => error!(CreationError::ZeroCash),
        ValidationError::CashTooLarge => error!(CreationError::CashTooLarge),
        ValidationError::ZeroMinimum => error!(CreationError::ZeroMinimum),
        ValidationError::NonceMismatch => error!(CreationError::NonceMismatch),
        ValidationError::NonceExhausted => error!(CreationError::NonceExhausted),
    }
}

fn accounting_error(error: AccountingError) -> anchor_lang::error::Error {
    match error {
        AccountingError::InvalidAmount(error) => creation_validation_error(error),
        AccountingError::ArithmeticOverflow => error!(CreationError::AccountingArithmeticOverflow),
        AccountingError::PayoutsExceedDeposits => {
            error!(CreationError::AccountingPayoutsExceedDeposits)
        }
    }
}

#[event]
pub struct OrderCreated {
    pub config: Pubkey,
    pub user: Pubkey,
    pub nonce: u64,
    pub order: Pubkey,
    pub order_id: [u8; 32],
    pub terms_hash: [u8; 32],
    pub market: [u8; 32],
    pub outcome: u8,
    pub cash_amount: u64,
    pub minimum_shares: u64,
    pub user_cash_ata: Pubkey,
    pub user_yes_ata: Pubkey,
    pub escrow: Pubkey,
}

// Anchor IDL permits one error enum. Creation uses its reserved 7000+ range.
use crate::configuration::InitializationError as CreationError;
