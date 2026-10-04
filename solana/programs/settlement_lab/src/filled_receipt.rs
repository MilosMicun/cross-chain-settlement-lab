//! Read-only v1 Filled-receipt validation and replay decisions.
//!
//! Config is supplied account data: this helper checks the specified data
//! relationships, but does not authenticate its public key or a deployed account.
//! Deployment authorization, account ownership, canonical PDA bindings, signer
//! authorization, token-account validity, and EVM finality belong to the future
//! instruction and its observation policy. Future acceptance requires the
//! configured operator signer. A receipt hash is a content fingerprint, not
//! execution proof; valid host data is not evidence of an actual EVM purchase.
//!
//! A decision never advances state or changes cancellation history. The future
//! instruction must preserve that history and atomically perform minting,
//! reimbursement, accounting, and persistence of Settled plus the receipt.

use anchor_lang::prelude::Pubkey;

use crate::{
    configuration::Config,
    order_state::{validate_amounts, AcceptedReceipt, Order, OrderState, ValidationError},
    protocol_encoding::{order_id, receipt_hash, terms_hash, Receipt, Terms},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilledDecision {
    Apply(AcceptedReceipt),
    Replay,
}

/// Plain business errors, independent of Anchor instruction error numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilledReceiptError {
    UnsupportedConfigVersion(u8),
    ConfigMismatch,
    MarketOutcomeMismatch,
    InvalidStoredAmounts(ValidationError),
    TermsMismatch,
    InvalidStoredOrderId,
    InvalidStoredTermsHash,
    InconsistentRecord,
    ReceiptTermsHashMismatch,
    InvalidFilledTerminal(u8),
    InvalidFilledQuantity { expected: u64, actual: u64 },
    MinimumNotMet,
    TerminalConflict,
}

/// Validate complete immutable terms, canonical hashes, stored lifecycle, and
/// exact full-fill economics before returning a decision. No account is mutated.
pub fn validate_filled_receipt(
    config_key: Pubkey,
    config: &Config,
    order: &Order,
    supplied_terms: &Terms,
    receipt: &Receipt,
) -> Result<FilledDecision, FilledReceiptError> {
    use FilledReceiptError::*;

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

    // Classify terminal conflicts only after establishing a consistent record.
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
    if receipt.terminal != 1 {
        return Err(InvalidFilledTerminal(receipt.terminal));
    }
    if receipt.filled_quantity != quantity {
        return Err(InvalidFilledQuantity {
            expected: quantity,
            actual: receipt.filled_quantity,
        });
    }
    if receipt.filled_quantity < order.minimum_shares {
        return Err(MinimumNotMet);
    }
    let accepted = AcceptedReceipt {
        terminal: receipt.terminal,
        filled_quantity: receipt.filled_quantity,
        receipt_hash: receipt_hash(receipt).map_err(|_| InvalidFilledTerminal(receipt.terminal))?,
    };

    match order.state {
        OrderState::Pending | OrderState::CancelRequested => Ok(FilledDecision::Apply(accepted)),
        OrderState::Settled if order.accepted_receipt == Some(accepted) => {
            Ok(FilledDecision::Replay)
        }
        OrderState::Settled | OrderState::Refunded => Err(TerminalConflict),
    }
}
