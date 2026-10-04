use anchor_lang::prelude::*;

pub mod accounting;
pub mod configuration;
pub mod filled_receipt;
pub mod order_cancellation;
pub mod order_creation;
pub mod order_state;
pub mod protocol_encoding;
use configuration::*;
use order_cancellation::*;
use order_creation::*;

// Fixed local program identity, also used by the upgradeable genesis fixture.
declare_id!("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");

#[program]
pub mod settlement_lab {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        configuration::initialize(ctx, args)
    }
    pub fn create_order(ctx: Context<CreateOrder>, args: CreateOrderArgs) -> Result<()> {
        order_creation::create_order(ctx, args)
    }
    pub fn request_cancel(
        ctx: Context<RequestCancel>,
        nonce: u64,
        expected_terms_hash: [u8; 32],
    ) -> Result<()> {
        order_cancellation::request_cancel(ctx, nonce, expected_terms_hash)
    }
}
