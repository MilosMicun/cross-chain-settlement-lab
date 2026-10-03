//! Permanent order records and pure creation bounds; no account or token operations.
//! These helpers do not verify PDA bindings or signer authorization.

use anchor_lang::prelude::*;

use crate::{
    configuration::Config,
    protocol_encoding::{Domain, Identity, Terms},
};

/// Permanent counter at `[b"user", config_pubkey, original_user]`.
/// Identity records must never be closed, reset, or reinitialized.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct UserNonce {
    pub config: Pubkey,
    pub user: Pubkey,
    pub next_nonce: u64,
    pub bump: u8,
}

/// Borsh source-state tags follow declaration order (0 through 3).
/// They are distinct from the EVM receipt terminal tags (Filled = 1, Cancelled = 2).
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderState {
    Pending,
    CancelRequested,
    Settled,
    Refunded,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AcceptedReceipt {
    pub terminal: u8,
    pub filled_quantity: u64,
    pub receipt_hash: [u8; 32],
}

/// Permanent record at `[b"order", config_pubkey, original_user, nonce.to_be_bytes()]`.
/// The escrow address uses `[b"escrow", order_pubkey]`.
/// Neither identity nor terminal history may be cleared by closing or reinitializing.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Order {
    pub config: Pubkey,
    pub user: Pubkey,
    pub nonce: u64,
    pub market: [u8; 32],
    pub outcome: u8,
    pub cash_amount: u64,
    pub minimum_shares: u64,
    pub order_id: [u8; 32],
    pub terms_hash: [u8; 32],
    pub user_cash_ata: Pubkey,
    pub user_yes_ata: Pubkey,
    pub escrow: Pubkey,
    pub state: OrderState,
    /// Retained after finalization for cancellation-request replay checks.
    pub cancellation_requested: bool,
    /// `None` means no accepted outcome; `Some` retains the terminal record.
    pub accepted_receipt: Option<AcceptedReceipt>,
    pub bump: u8,
    pub escrow_bump: u8,
}

impl Order {
    /// Reconstruct canonical terms from the supplied immutable configuration and
    /// stored order fields. Hash these with `protocol_encoding::order_id` and
    /// `protocol_encoding::terms_hash`; account Borsh bytes are not hash preimages.
    ///
    /// Reconstruction is not authorization or validation of the stored hashes.
    /// The later instruction must verify the Config account and `self.config`
    /// relationship, along with all account bindings and signer requirements.
    pub fn terms(&self, config: &Config) -> Terms {
        Terms {
            identity: Identity {
                domain: Domain {
                    source_domain: config.source_domain,
                    destination_domain: config.destination_domain,
                    solana_program: config.solana_program.to_bytes(),
                    chain_id: config.chain_id,
                    settlement: config.settlement,
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

/// Pure validation failures, independent of Anchor custom error numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationError {
    ZeroCash,
    CashTooLarge,
    ZeroMinimum,
    NonceMismatch,
    NonceExhausted,
}

/// Return exact full-fill shares in integer base units at the fixed v1 price.
/// A positive minimum may exceed the output; creation does not promise execution.
pub fn validate_amounts(
    cash_amount: u64,
    minimum_shares: u64,
) -> std::result::Result<u64, ValidationError> {
    if cash_amount == 0 {
        return Err(ValidationError::ZeroCash);
    }
    if cash_amount > u64::MAX / 2 {
        return Err(ValidationError::CashTooLarge);
    }
    if minimum_shares == 0 {
        return Err(ValidationError::ZeroMinimum);
    }
    cash_amount
        .checked_mul(2)
        .ok_or(ValidationError::CashTooLarge)
}

/// Validate a NEW order nonce without mutating its permanent counter.
/// The last usable nonce is `u64::MAX - 1`; exhaustion never wraps.
/// Existing-order replay must be checked separately before advancing a nonce.
pub fn checked_next_nonce(
    expected: u64,
    supplied: u64,
) -> std::result::Result<u64, ValidationError> {
    if supplied != expected {
        return Err(ValidationError::NonceMismatch);
    }
    expected
        .checked_add(1)
        .ok_or(ValidationError::NonceExhausted)
}
