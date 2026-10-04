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

/// Fill accounting failures, independent of Anchor custom error numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillAccountingError {
    Accounting(AccountingError),
    InvalidFilledQuantity { expected: u64, actual: u64 },
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

    /// Record one refund in base units using checked accounting arithmetic only.
    /// Every failure preserves the entire record; success changes only refunds.
    ///
    /// The caller must authenticate the configured operator and canonical
    /// accounts, validate immutable terms, prior user cancellation, and the
    /// terminal Cancelled receipt with zero output. Only a newly accepted
    /// cancellation calls this helper; exact replay must bypass it entirely.
    /// The helper itself does not prevent duplicate calls, inspect an Order,
    /// accept receipts, transfer tokens, or authenticate accounts.
    /// The future instruction must atomically combine this update with the
    /// escrow transfer and persistent Refunded/AcceptedReceipt state.
    /// Timeout, execution failure, or missing acknowledgement is not permission
    /// to refund. Refunds do not mint YES or decrease cumulative issuance.
    /// Unsolicited escrow donations, rent, and fees are outside these counters.
    pub fn record_refund(&mut self, cash_amount: u64) -> std::result::Result<(), AccountingError> {
        // A fixed positive minimum reuses cash validation, not the order's
        // actual minimum shares.
        validate_amounts(cash_amount, 1).map_err(AccountingError::InvalidAmount)?;
        self.outstanding_cash()?;
        let refunded = self
            .total_refunded
            .checked_add(u128::from(cash_amount))
            .ok_or(AccountingError::ArithmeticOverflow)?;
        let payouts = refunded
            .checked_add(self.total_reimbursed)
            .ok_or(AccountingError::ArithmeticOverflow)?;
        if payouts > self.total_deposited {
            return Err(AccountingError::PayoutsExceedDeposits);
        }

        self.total_refunded = refunded;
        Ok(())
    }

    /// Record one fill's reimbursement and cumulative YES issuance in base units.
    /// Every failure preserves the entire record; success changes only those
    /// two counters. This helper performs checked accounting arithmetic only.
    ///
    /// The caller must validate the configured operator, account bindings,
    /// immutable terms, and Filled receipt, including the order's minimum shares.
    /// Invoke this helper only for a newly accepted fill; replay must bypass it
    /// entirely. The helper itself does not deduplicate calls or accept receipts,
    /// mint tokens, transfer cash, authenticate accounts, or advance an Order.
    /// Actual settlement must atomically combine these counter updates with SPL
    /// minting, reimbursement, and persistent terminal Order state.
    /// Cumulative issuance is not current mint supply and must not decrease
    /// after user burns.
    pub fn record_fill(
        &mut self,
        cash_amount: u64,
        filled_quantity: u64,
    ) -> std::result::Result<(), FillAccountingError> {
        let expected = validate_amounts(cash_amount, 1)
            .map_err(AccountingError::InvalidAmount)
            .map_err(FillAccountingError::Accounting)?;
        if filled_quantity != expected {
            return Err(FillAccountingError::InvalidFilledQuantity {
                expected,
                actual: filled_quantity,
            });
        }

        self.outstanding_cash()
            .map_err(FillAccountingError::Accounting)?;
        let reimbursed = self
            .total_reimbursed
            .checked_add(u128::from(cash_amount))
            .ok_or(AccountingError::ArithmeticOverflow)
            .map_err(FillAccountingError::Accounting)?;
        let payouts = self
            .total_refunded
            .checked_add(reimbursed)
            .ok_or(AccountingError::ArithmeticOverflow)
            .map_err(FillAccountingError::Accounting)?;
        if payouts > self.total_deposited {
            return Err(FillAccountingError::Accounting(
                AccountingError::PayoutsExceedDeposits,
            ));
        }
        let shares_minted = self
            .total_shares_minted
            .checked_add(u128::from(filled_quantity))
            .ok_or(AccountingError::ArithmeticOverflow)
            .map_err(FillAccountingError::Accounting)?;

        self.total_reimbursed = reimbursed;
        self.total_shares_minted = shares_minted;
        Ok(())
    }
}
