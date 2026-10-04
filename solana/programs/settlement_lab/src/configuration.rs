use crate::accounting::Accounting;
use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::{spl_token::state::AccountState, Mint, Token, TokenAccount},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub source_domain: [u8; 32],
    pub destination_domain: [u8; 32],
    pub chain_id: [u8; 32],
    pub settlement: [u8; 20],
    pub venue: [u8; 20],
    pub cash_token: [u8; 20],
    pub yes_token: [u8; 20],
    pub evm_operator: [u8; 20],
    pub evm_executor: [u8; 20],
    pub market: [u8; 32],
    pub solana_operator: Pubkey,
    pub solana_executor: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub source_domain: [u8; 32],
    pub destination_domain: [u8; 32],
    pub solana_program: Pubkey,
    pub chain_id: [u8; 32],
    pub settlement: [u8; 20],
    pub venue: [u8; 20],
    pub cash_token: [u8; 20],
    pub yes_token: [u8; 20],
    pub evm_operator: [u8; 20],
    pub evm_executor: [u8; 20],
    pub market: [u8; 32],
    pub outcome: u8,
    pub solana_operator: Pubkey,
    pub solana_executor: Pubkey,
    pub cash_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub executor_cash_ata: Pubkey,
    pub yes_mint_authority: Pubkey,
    pub token_program: Pubkey,
    pub associated_token_program: Pubkey,
    pub system_program: Pubkey,
    pub bump: u8,
    pub yes_authority_bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(
        owner = bpf_loader_upgradeable::ID,
        constraint = program.programdata_address()? == Some(program_data.key()) @ InitializationError::UnlinkedProgramData
    )]
    pub program: Program<'info, crate::program::SettlementLab>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(initializer.key()) @ InitializationError::UnauthorizedInitializer
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = initializer, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = initializer, space = 8 + Accounting::INIT_SPACE,
        seeds = [b"accounting", config.key().as_ref()], bump)]
    pub accounting: Account<'info, Accounting>,
    pub cash_mint: Account<'info, Mint>,
    pub yes_mint: Account<'info, Mint>,
    pub executor_cash_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(
        args.source_domain != [0; 32] && args.destination_domain != [0; 32],
        InitializationError::ZeroDomain
    );
    require!(
        args.source_domain != args.destination_domain,
        InitializationError::EqualDomains
    );
    require!(args.chain_id != [0; 32], InitializationError::ZeroChainId);
    require!(args.market != [0; 32], InitializationError::ZeroMarket);
    require!(
        [
            args.settlement,
            args.venue,
            args.cash_token,
            args.yes_token,
            args.evm_operator,
            args.evm_executor,
        ]
        .iter()
        .all(|address| *address != [0; 20]),
        InitializationError::ZeroEvmAddress
    );
    require!(
        args.evm_operator != args.evm_executor,
        InitializationError::EqualEvmRoles
    );
    require!(
        args.cash_token != args.yes_token,
        InitializationError::EqualEvmTokens
    );
    require!(
        args.solana_operator != Pubkey::default() && args.solana_executor != Pubkey::default(),
        InitializationError::ZeroSolanaRole
    );
    require!(
        args.solana_operator != args.solana_executor,
        InitializationError::EqualSolanaRoles
    );

    let accounts = ctx.accounts;
    require_keys_neq!(
        accounts.cash_mint.key(),
        accounts.yes_mint.key(),
        InitializationError::EqualSourceMints
    );
    require!(
        accounts.cash_mint.is_initialized && accounts.yes_mint.is_initialized,
        InitializationError::UninitializedMint
    );
    require!(
        accounts.cash_mint.decimals == 6 && accounts.yes_mint.decimals == 6,
        InitializationError::WrongDecimals
    );
    require!(
        accounts.cash_mint.freeze_authority.is_none()
            && accounts.yes_mint.freeze_authority.is_none(),
        InitializationError::FreezeAuthority
    );
    require!(
        accounts.yes_mint.supply == 0,
        InitializationError::NonzeroYesSupply
    );
    let (yes_authority, yes_authority_bump) = Pubkey::find_program_address(
        &[b"yes-authority", accounts.config.key().as_ref()],
        &crate::ID,
    );
    require!(
        accounts.yes_mint.mint_authority == Some(yes_authority).into(),
        InitializationError::WrongYesAuthority
    );
    let reimbursement = &accounts.executor_cash_ata;
    require_keys_eq!(
        reimbursement.owner,
        args.solana_executor,
        InitializationError::WrongReimbursementOwner
    );
    require_keys_eq!(
        reimbursement.mint,
        accounts.cash_mint.key(),
        InitializationError::WrongReimbursementMint
    );
    require_keys_eq!(
        reimbursement.key(),
        get_associated_token_address_with_program_id(
            &args.solana_executor,
            &accounts.cash_mint.key(),
            &Token::id(),
        ),
        InitializationError::NoncanonicalReimbursement
    );
    require!(
        reimbursement.state == AccountState::Initialized,
        InitializationError::UnsafeReimbursementState
    );
    require!(
        reimbursement.delegate.is_none(),
        InitializationError::ReimbursementDelegate
    );
    require!(
        reimbursement.close_authority.is_none(),
        InitializationError::ReimbursementCloseAuthority
    );

    // EVM inputs are trusted configuration; this instruction cannot inspect EVM storage.
    accounts.config.set_inner(Config {
        version: 1,
        source_domain: args.source_domain,
        destination_domain: args.destination_domain,
        solana_program: crate::ID,
        chain_id: args.chain_id,
        settlement: args.settlement,
        venue: args.venue,
        cash_token: args.cash_token,
        yes_token: args.yes_token,
        evm_operator: args.evm_operator,
        evm_executor: args.evm_executor,
        market: args.market,
        outcome: 0,
        solana_operator: args.solana_operator,
        solana_executor: args.solana_executor,
        cash_mint: accounts.cash_mint.key(),
        yes_mint: accounts.yes_mint.key(),
        executor_cash_ata: reimbursement.key(),
        yes_mint_authority: yes_authority,
        token_program: Token::id(),
        associated_token_program: AssociatedToken::id(),
        system_program: System::id(),
        bump: ctx.bumps.config,
        yes_authority_bump,
    });
    accounts.accounting.set_inner(Accounting {
        config: accounts.config.key(),
        total_deposited: 0,
        total_refunded: 0,
        total_reimbursed: 0,
        total_shares_minted: 0,
        bump: ctx.bumps.accounting,
    });
    Ok(())
}

#[error_code]
pub enum InitializationError {
    #[msg("ProgramData is not linked to this program")]
    UnlinkedProgramData,
    #[msg("Initializer is not the current deployment upgrade authority")]
    UnauthorizedInitializer,
    #[msg("Deployment domains must be nonzero")]
    ZeroDomain,
    #[msg("Deployment domains must be distinct")]
    EqualDomains,
    #[msg("EVM chain ID must be nonzero")]
    ZeroChainId,
    #[msg("Market ID must be nonzero")]
    ZeroMarket,
    #[msg("EVM addresses must be nonzero")]
    ZeroEvmAddress,
    #[msg("EVM operator and executor must be distinct")]
    EqualEvmRoles,
    #[msg("EVM cash and YES tokens must be distinct")]
    EqualEvmTokens,
    #[msg("Solana roles must be nonzero")]
    ZeroSolanaRole,
    #[msg("Solana operator and executor must be distinct")]
    EqualSolanaRoles,
    #[msg("Source cash and YES mints must be distinct")]
    EqualSourceMints,
    #[msg("Source mints must be initialized")]
    UninitializedMint,
    #[msg("Source mints must have six decimals")]
    WrongDecimals,
    #[msg("Source mints must have no freeze authority")]
    FreezeAuthority,
    #[msg("Initial YES supply must be zero")]
    NonzeroYesSupply,
    #[msg("YES mint authority must be the canonical configuration PDA")]
    WrongYesAuthority,
    #[msg("Reimbursement token authority must be the executor")]
    WrongReimbursementOwner,
    #[msg("Reimbursement mint must be the source cash mint")]
    WrongReimbursementMint,
    #[msg("Reimbursement account must be the canonical legacy cash ATA")]
    NoncanonicalReimbursement,
    #[msg("Reimbursement account must be initialized and unfrozen")]
    UnsafeReimbursementState,
    #[msg("Reimbursement account must have no delegate")]
    ReimbursementDelegate,
    #[msg("Reimbursement account must have no close authority")]
    ReimbursementCloseAuthority,

    // Creation codes start at 7000; existing initialization codes remain unchanged.
    #[msg("Configuration version, identity, or stored bindings are invalid")]
    InvalidConfig = 1000,
    #[msg("Account does not match its permanent stored relationship")]
    InvalidBinding,
    #[msg("Operator and executor cannot create user orders")]
    ReservedUser,
    #[msg("Protocol accounts must not alias")]
    UnsafeAlias,
    #[msg("Configured mints must be initialized, six-decimal, and have safe authorities")]
    InvalidMint,
    #[msg("User token account has the wrong mint or original owner")]
    InvalidUserToken,
    #[msg("User token account is not the canonical legacy ATA")]
    NoncanonicalAta,
    #[msg("User token account must be initialized and unfrozen")]
    UnsafeTokenState,
    #[msg("Escrow mint, authority, state, delegate, or close authority is unsafe")]
    UnsafeEscrow,
    #[msg("Cash amount must be positive")]
    ZeroCash,
    #[msg("Cash amount exceeds the exact-output uint64 bound")]
    CashTooLarge,
    #[msg("Minimum shares must be positive")]
    ZeroMinimum,
    #[msg("New order nonce must equal the permanent next nonce")]
    NonceMismatch,
    #[msg("Permanent user nonce is exhausted")]
    NonceExhausted,
    #[msg("Existing order immutable terms or canonical hashes conflict")]
    TermsConflict,
    #[msg("Checked transfer did not produce the exact expected balances")]
    UnexpectedBalance,

    // Cancellation codes start at 8000; all earlier codes remain unchanged.
    #[msg("Cancellation configuration version, identity, or bindings are invalid")]
    CancellationInvalidConfig = 2000,
    #[msg("Cancellation account or stored address does not match its canonical binding")]
    CancellationInvalidBinding,
    #[msg("Stored cancellation order amounts are invalid")]
    CancellationInvalidAmounts,
    #[msg("Cancellation immutable terms or expected hash conflict")]
    CancellationTermsConflict,
    #[msg("Order state, cancellation flag, or accepted receipt is inconsistent")]
    CancellationInconsistentRecord,
    #[msg("A terminal order cannot accept a new cancellation request")]
    CancellationTerminalWithoutRequest,

    // Accounting codes start at 9000; all earlier codes remain unchanged.
    #[msg("Accounting does not match its canonical configuration or bump")]
    AccountingInvalidBinding = 3000,
    #[msg("Checked source accounting arithmetic overflowed")]
    AccountingArithmeticOverflow,
    #[msg("Recorded source payouts exceed accepted deposits")]
    AccountingPayoutsExceedDeposits,

    // Filled acceptance codes start at 10000; all earlier codes remain unchanged.
    #[msg("Filled configuration identity, domains, or pinned bindings are invalid")]
    FilledInvalidConfig = 4000,
    #[msg("Filled account does not match its canonical permanent binding")]
    FilledInvalidBinding,
    #[msg("Filled acceptance requires the configured operator signer")]
    FilledUnauthorizedOperator,
    #[msg("Operator and executor cannot be original order users")]
    FilledReservedUser,
    #[msg("Filled protocol accounts must not alias")]
    FilledUnsafeAlias,
    #[msg("Filled mints must be initialized, six-decimal, and have safe authorities")]
    FilledInvalidMint,
    #[msg("Filled token account mint, authority, state, or payout restrictions are unsafe")]
    FilledUnsafeToken,
    #[msg("Filled immutable terms or canonical stored hashes conflict")]
    FilledTermsConflict,
    #[msg("Filled receipt terms hash, terminal, quantity, or minimum is invalid")]
    FilledInvalidReceipt,
    #[msg("Filled lifecycle or retained terminal receipt is inconsistent or conflicting")]
    FilledInconsistentRecord,
    #[msg("Filled token operations did not produce exact expected balance and supply deltas")]
    FilledUnexpectedBalance,

    // Refund acceptance codes start at 11000; all earlier codes remain unchanged.
    #[msg("Refund configuration identity, domains, or pinned bindings are invalid")]
    RefundInvalidConfig = 5000,
    #[msg("Refund account does not match its canonical permanent binding")]
    RefundInvalidBinding,
    #[msg("Refund acceptance requires the configured operator signer")]
    RefundUnauthorizedOperator,
    #[msg("Operator and executor cannot be original refund users")]
    RefundReservedUser,
    #[msg("Refund protocol accounts must not alias")]
    RefundUnsafeAlias,
    #[msg("Refund cash mint must be initialized, six-decimal, and without freeze authority")]
    RefundInvalidMint,
    #[msg("Refund token account mint, authority, state, or escrow restrictions are unsafe")]
    RefundUnsafeToken,
    #[msg("Refund incoming immutable terms conflict with the stored order")]
    RefundTermsConflict,
    #[msg("Cancelled receipt terms hash, terminal, or zero quantity is invalid")]
    RefundInvalidReceipt,
    #[msg("Refund requires a prior user cancellation request")]
    RefundCancellationNotRequested,
    #[msg("Refund stored terms, lifecycle, or retained terminal receipt is inconsistent")]
    RefundInconsistentRecord,
    #[msg("Cancelled receipt conflicts with the permanent terminal outcome")]
    RefundTerminalConflict,
    #[msg("Refund token transfer did not produce exact expected balance deltas")]
    RefundUnexpectedBalance,
    #[msg("Refund stored order or accounting cash amount is invalid")]
    RefundInvalidAmount,
}
