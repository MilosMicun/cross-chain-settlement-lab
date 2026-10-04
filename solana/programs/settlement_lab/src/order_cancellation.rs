//! User-signed cancellation intent only. No allocation, CPI, or receipt acceptance.

use crate::{
    configuration::{Config, InitializationError as CancellationError},
    order_state::{validate_amounts, Order, OrderState},
    protocol_encoding::{order_id, receipt_hash, terms_hash, Receipt},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::Token,
};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RequestCancel<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump,
        constraint = config.bump == Pubkey::find_program_address(&[b"config"], &crate::ID).1 @ CancellationError::CancellationInvalidBinding)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"order", config.key().as_ref(), user.key().as_ref(), &nonce.to_be_bytes()], bump)]
    pub order: Box<Account<'info, Order>>,
}

pub fn request_cancel(
    ctx: Context<RequestCancel>,
    nonce: u64,
    expected_terms_hash: [u8; 32],
) -> Result<()> {
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
        CancellationError::CancellationInvalidConfig
    );

    let o = &mut a.order;
    let (escrow, escrow_bump) =
        Pubkey::find_program_address(&[b"escrow", o.key().as_ref()], &crate::ID);
    require!(
        o.config == c.key()
            && o.user == a.user.key()
            && o.nonce == nonce
            && o.bump == ctx.bumps.order
            && o.market == c.market
            && o.outcome == c.outcome
            && o.user_cash_ata
                == get_associated_token_address_with_program_id(
                    &o.user,
                    &c.cash_mint,
                    &Token::id()
                )
            && o.user_yes_ata
                == get_associated_token_address_with_program_id(&o.user, &c.yes_mint, &Token::id())
            && o.escrow == escrow
            && o.escrow_bump == escrow_bump,
        CancellationError::CancellationInvalidBinding
    );
    validate_amounts(o.cash_amount, o.minimum_shares)
        .map_err(|_| error!(CancellationError::CancellationInvalidAmounts))?;
    let terms = o.terms(c);
    require!(
        o.order_id == order_id(&terms.identity)
            && o.terms_hash == terms_hash(&terms)
            && expected_terms_hash == o.terms_hash,
        CancellationError::CancellationTermsConflict
    );
    let changed = apply_cancellation_request(o).map_err(|error| match error {
        CancellationTransitionError::InconsistentRecord => {
            error!(CancellationError::CancellationInconsistentRecord)
        }
        CancellationTransitionError::TerminalWithoutRequest => {
            error!(CancellationError::CancellationTerminalWithoutRequest)
        }
    })?;
    if changed {
        emit!(CancellationRequested {
            config: c.key(),
            user: a.user.key(),
            order: o.key(),
            nonce,
            order_id: o.order_id,
            terms_hash: o.terms_hash,
        });
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancellationTransitionError {
    InconsistentRecord,
    TerminalWithoutRequest,
}

/// Validate lifecycle consistency before mutating. Returns true only for a new
/// request. Account bindings and original-user authorization belong to the handler.
/// Terminal fixtures are supported for replay; this helper never accepts receipts.
pub fn apply_cancellation_request(
    order: &mut Order,
) -> std::result::Result<bool, CancellationTransitionError> {
    use CancellationTransitionError::*;
    match order.state {
        OrderState::Pending | OrderState::CancelRequested => {
            if order.accepted_receipt.is_some()
                || order.cancellation_requested != (order.state == OrderState::CancelRequested)
            {
                return Err(InconsistentRecord);
            }
        }
        OrderState::Settled | OrderState::Refunded => {
            let accepted = order.accepted_receipt.ok_or(InconsistentRecord)?;
            let quantity = validate_amounts(order.cash_amount, order.minimum_shares)
                .map_err(|_| InconsistentRecord)?;
            let consistent = match order.state {
                OrderState::Settled => {
                    accepted.terminal == 1
                        && accepted.filled_quantity == quantity
                        && quantity >= order.minimum_shares
                }
                OrderState::Refunded => {
                    accepted.terminal == 2
                        && accepted.filled_quantity == 0
                        && order.cancellation_requested
                }
                _ => unreachable!(),
            };
            let receipt = Receipt {
                terms_hash: order.terms_hash,
                terminal: accepted.terminal,
                filled_quantity: accepted.filled_quantity,
            };
            if !consistent || receipt_hash(&receipt).ok() != Some(accepted.receipt_hash) {
                return Err(InconsistentRecord);
            }
            if !order.cancellation_requested {
                return Err(TerminalWithoutRequest);
            }
            return Ok(false);
        }
    }
    if order.state == OrderState::CancelRequested {
        return Ok(false);
    }
    order.state = OrderState::CancelRequested;
    order.cancellation_requested = true;
    Ok(true)
}

#[event]
pub struct CancellationRequested {
    pub config: Pubkey,
    pub user: Pubkey,
    pub order: Pubkey,
    pub nonce: u64,
    pub order_id: [u8; 32],
    pub terms_hash: [u8; 32],
}
