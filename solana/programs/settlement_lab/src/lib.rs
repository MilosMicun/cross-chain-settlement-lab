use anchor_lang::prelude::*;

pub mod configuration;
pub mod order_state;
pub mod protocol_encoding;
use configuration::*;

// Fixed local program identity, also used by the upgradeable genesis fixture.
declare_id!("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");

#[program]
pub mod settlement_lab {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        configuration::initialize(ctx, args)
    }
}
