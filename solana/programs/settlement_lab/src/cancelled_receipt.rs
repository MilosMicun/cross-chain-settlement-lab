//! Read-only v1 Cancelled-receipt validation and replay decisions.
//!
//! This helper validates supplied data and returns a decision; it never mutates
//! accounts or performs a refund. The future instruction must authenticate
//! canonical accounts (ownership, discriminators, PDA bindings) and the configured
//! operator signer, verify token bindings, and atomically perform refund
//! accounting, token transfer, and Refunded/AcceptedReceipt persistence.
//!
//! A cancellation flag represents previously recorded user intent; this helper
//! does not verify a historical signature. A receipt hash is a content
//! fingerprint, not proof of EVM execution or finality. A timeout, execution
//! revert, or missing acknowledgement must not establish refund eligibility.

use anchor_lang::prelude::Pubkey;

use crate::{
    configuration::Config,
    order_state::{validate_amounts, AcceptedReceipt, Order, OrderState, ValidationError},
    protocol_encoding::{order_id, receipt_hash, terms_hash, Receipt, Terms},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelledDecision {
    Apply(AcceptedReceipt),
    Replay,
}

/// Plain business errors, independent of Anchor instruction error numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelledReceiptError {
    UnsupportedConfigVersion(u8),
    ConfigMismatch,
    MarketOutcomeMismatch,
    InvalidStoredAmounts(ValidationError),
    TermsMismatch,
    InvalidStoredOrderId,
    InvalidStoredTermsHash,
    InconsistentRecord,
    ReceiptTermsHashMismatch,
    InvalidCancelledTerminal(u8),
    NonzeroCancelledQuantity(u64),
    CancellationNotRequested,
    TerminalConflict,
}

/// Validate complete immutable terms, canonical hashes, stored lifecycle, and
/// a zero-output cancellation receipt before returning a decision. Borrowed
/// inputs remain unchanged. An unattainable positive minimum permits cancellation.
pub fn validate_cancelled_receipt(
    config_key: Pubkey,
    config: &Config,
    order: &Order,
    supplied_terms: &Terms,
    receipt: &Receipt,
) -> Result<CancelledDecision, CancelledReceiptError> {
    use CancelledReceiptError::*;

    if config.version != 1 {
        return Err(UnsupportedConfigVersion(config.version));
    }
    if order.config != config_key {
        return Err(ConfigMismatch);
    }
    if order.market != config.market || order.outcome != config.outcome || config.outcome != 0 {
        return Err(MarketOutcomeMismatch);
    }
    let quantity =
        validate_amounts(order.cash_amount, order.minimum_shares).map_err(InvalidStoredAmounts)?;
    let expected_terms = order.terms(config);
    if *supplied_terms != expected_terms {
        return Err(TermsMismatch);
    }
    if order.order_id != order_id(&expected_terms.identity) {
        return Err(InvalidStoredOrderId);
    }
    let validated_terms_hash = terms_hash(&expected_terms);
    if order.terms_hash != validated_terms_hash {
        return Err(InvalidStoredTermsHash);
    }

    // Corrupt terminal records are neither legitimate conflicts nor replays.
    match order.state {
        OrderState::Pending | OrderState::CancelRequested => {
            if order.accepted_receipt.is_some()
                || order.cancellation_requested != (order.state == OrderState::CancelRequested)
            {
                return Err(InconsistentRecord);
            }
        }
        OrderState::Settled | OrderState::Refunded => {
            let retained = order.accepted_receipt.ok_or(InconsistentRecord)?;
            let consistent = match order.state {
                OrderState::Settled => {
                    retained.terminal == 1
                        && retained.filled_quantity == quantity
                        && quantity >= order.minimum_shares
                }
                OrderState::Refunded => {
                    retained.terminal == 2
                        && retained.filled_quantity == 0
                        && order.cancellation_requested
                }
                _ => unreachable!(),
            };
            let retained_receipt = Receipt {
                terms_hash: validated_terms_hash,
                terminal: retained.terminal,
                filled_quantity: retained.filled_quantity,
            };
            if !consistent || receipt_hash(&retained_receipt).ok() != Some(retained.receipt_hash) {
                return Err(InconsistentRecord);
            }
        }
    }

    if receipt.terms_hash != validated_terms_hash {
        return Err(ReceiptTermsHashMismatch);
    }
    if receipt.terminal != 2 {
        return Err(InvalidCancelledTerminal(receipt.terminal));
    }
    if receipt.filled_quantity != 0 {
        return Err(NonzeroCancelledQuantity(receipt.filled_quantity));
    }
    let accepted = AcceptedReceipt {
        terminal: receipt.terminal,
        filled_quantity: receipt.filled_quantity,
        receipt_hash: receipt_hash(receipt)
            .map_err(|_| InvalidCancelledTerminal(receipt.terminal))?,
    };

    match order.state {
        OrderState::Pending => Err(CancellationNotRequested),
        OrderState::CancelRequested => Ok(CancelledDecision::Apply(accepted)),
        OrderState::Refunded if order.accepted_receipt == Some(accepted) => {
            Ok(CancelledDecision::Replay)
        }
        OrderState::Settled | OrderState::Refunded => Err(TerminalConflict),
    }
}
