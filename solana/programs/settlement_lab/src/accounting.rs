//! Permanent source accounting state and checked arithmetic.
//! Initialization and creation enforce authorization and account bindings;
//! these helpers perform no token operations or receipt processing.

use anchor_lang::prelude::*;

use crate::order_state::{validate_amounts, ValidationError};

/// Permanent account with canonical seeds `[b"accounting", config_pubkey]`.
/// Counters start at zero and use integer base units. Faucet minting, transfers
/// between users, unsolicited escrow donations, SOL rent, and transaction fees
/// are outside these counters. This record must never be closed or reset.
/// Account serialization is Borsh, distinct from canonical protocol hash encoding.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Accounting {
    pub config: Pubkey,
    /// Accepted new-order cash deposits, counted once.
    pub total_deposited: u128,
    /// Cash returned by accepted cancellation receipts.
    pub total_refunded: u128,
    /// Cash paid to the executor by accepted fill receipts.
    pub total_reimbursed: u128,
    /// Cumulative protocol YES issuance, never reduced by user burns.
    pub total_shares_minted: u128,
    pub bump: u8,
}

/// Plain Rust failures, independent of Anchor custom error numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountingError {
    InvalidAmount(ValidationError),
    ArithmeticOverflow,
    PayoutsExceedDeposits,
}

impl Accounting {
    /// Return order-attributable outstanding cash without changing any field.
    /// Overflow in the payout sum is distinct from payouts exceeding deposits.
    pub fn outstanding_cash(&self) -> std::result::Result<u128, AccountingError> {
        let payouts = self
            .total_refunded
            .checked_add(self.total_reimbursed)
            .ok_or(AccountingError::ArithmeticOverflow)?;
        self.total_deposited
            .checked_sub(payouts)
            .ok_or(AccountingError::PayoutsExceedDeposits)
    }

    /// Record a valid deposit only after checking the existing cash accounting.
    /// Every failure preserves the entire record; success changes only deposits.
    ///
    /// This helper does not prevent duplicate calls. Creation invokes it only
    /// on the NEW order path and bypasses it on replay,
    /// atomically with the order creation and token operations.
    pub fn record_deposit(&mut self, cash_amount: u64) -> std::result::Result<(), AccountingError> {
        // A fixed positive minimum reuses the existing v1 cash validation.
        // This helper does not validate an order's actual minimum shares.
        validate_amounts(cash_amount, 1).map_err(AccountingError::InvalidAmount)?;
        self.outstanding_cash()?;
        let successor = self
            .total_deposited
            .checked_add(u128::from(cash_amount))
            .ok_or(AccountingError::ArithmeticOverflow)?;
        self.total_deposited = successor;
        Ok(())
    }
}
