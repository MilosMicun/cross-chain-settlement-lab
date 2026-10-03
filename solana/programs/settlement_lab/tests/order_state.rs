use anchor_lang::{
    prelude::{Pubkey, Space},
    AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, Discriminator,
};
use settlement_lab::{
    configuration::Config,
    order_state::{
        checked_next_nonce, validate_amounts, AcceptedReceipt, Order, OrderState, UserNonce,
        ValidationError,
    },
    protocol_encoding::{order_id, terms_hash, Domain, Identity, Terms},
};

// Independently counted Borsh widths, excluding account discriminators.
const USER_NONCE_BYTES: usize = 2 * 32 + 8 + 1;
const RECEIPT_BYTES: usize = 1 + 8 + 32;
const ORDER_BYTES_WITHOUT_RECEIPT: usize = 5 * 32 + 3 * 32 + 3 * 8 + 1 + 1 + 1 + 1 + 2;
// Five public keys, three byte arrays, three u64s, outcome, state, bool,
// Option tag, and two bumps. Some adds one fixed-width receipt.
const ORDER_MAX_BYTES: usize = ORDER_BYTES_WITHOUT_RECEIPT + RECEIPT_BYTES;

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

// Host storage fixture only: no initialization, PDA, or account authorization
// is established. Unlike the SPEC encoding vector, it uses the actual program ID.
fn config_fixture() -> Config {
    Config {
        version: 1,
        source_domain: [0xa1; 32],
        destination_domain: [0xa2; 32],
        solana_program: settlement_lab::ID,
        chain_id: [0xa3; 32],
        settlement: [0xa4; 20],
        venue: [0xa5; 20],
        cash_token: [0xa6; 20],
        yes_token: [0xa7; 20],
        evm_operator: [0xa8; 20],
        evm_executor: [0xa9; 20],
        market: [0xaa; 32],
        outcome: 0,
        solana_operator: key(0xb1),
        solana_executor: key(0xb2),
        cash_mint: key(0xb3),
        yes_mint: key(0xb4),
        executor_cash_ata: key(0xb5),
        yes_mint_authority: key(0xb6),
        token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
        bump: 254,
        yes_authority_bump: 253,
    }
}

fn order_fixture() -> Order {
    Order {
        config: key(0xc1),
        user: key(0x55),
        nonce: 7,
        market: [0x66; 32],
        outcome: 0,
        cash_amount: 10_000_000,
        minimum_shares: 20_000_000,
        order_id: [0xc2; 32],
        terms_hash: [0xc3; 32],
        user_cash_ata: key(0xc4),
        user_yes_ata: key(0xc5),
        escrow: key(0xc6),
        state: OrderState::Pending,
        cancellation_requested: false,
        accepted_receipt: None,
        bump: 252,
        escrow_bump: 251,
    }
}

fn nonce_fixture(next_nonce: u64) -> UserNonce {
    UserNonce {
        config: key(0xc1),
        user: key(0x55),
        next_nonce,
        bump: 250,
    }
}

fn receipt_fixture() -> AcceptedReceipt {
    AcceptedReceipt {
        terminal: 1,
        filled_quantity: 20_000_000,
        receipt_hash: [0xd1; 32],
    }
}

#[test]
fn zero_cash_and_zero_minimum_are_distinct_errors() {
    assert_eq!(validate_amounts(0, 1), Err(ValidationError::ZeroCash));
    assert_eq!(validate_amounts(1, 0), Err(ValidationError::ZeroMinimum));
}

#[test]
fn cash_bounds_produce_exact_checked_output() {
    assert_eq!(validate_amounts(1, 1), Ok(2));
    assert_eq!(validate_amounts(u64::MAX / 2, 1), Ok(u64::MAX - 1));
    for cash in [u64::MAX / 2 + 1, u64::MAX] {
        assert_eq!(
            validate_amounts(cash, 1),
            Err(ValidationError::CashTooLarge)
        );
    }
}

#[test]
fn unattainable_positive_minimum_is_allowed_at_creation() {
    for minimum in [3, u64::MAX] {
        assert_eq!(validate_amounts(1, minimum), Ok(2));
    }
    assert_eq!(validate_amounts(u64::MAX / 2, u64::MAX), Ok(u64::MAX - 1));
}

#[test]
fn six_decimal_amounts_use_integer_base_units_without_rounding() {
    // One USD yields two YES; 0.500001 USD yields 1.000002 YES.
    assert_eq!(validate_amounts(1_000_000, 2_000_000), Ok(2_000_000));
    assert_eq!(validate_amounts(500_001, 1_000_002), Ok(1_000_002));
}

#[test]
fn new_order_nonce_accepts_initial_and_last_usable_values() {
    assert_eq!(checked_next_nonce(0, 0), Ok(1));
    assert_eq!(checked_next_nonce(u64::MAX - 1, u64::MAX - 1), Ok(u64::MAX));
}

#[test]
fn stale_future_and_exhausted_nonces_leave_counter_unchanged() {
    for (expected, supplied, error) in [
        (7, 6, ValidationError::NonceMismatch),
        (7, 8, ValidationError::NonceMismatch),
        (u64::MAX, u64::MAX, ValidationError::NonceExhausted),
    ] {
        let counter = nonce_fixture(expected);
        let before = counter.clone();
        assert_eq!(checked_next_nonce(counter.next_nonce, supplied), Err(error));
        assert_eq!(counter, before);
    }
}

#[test]
fn init_space_matches_independent_field_widths() {
    assert_eq!(USER_NONCE_BYTES, 73);
    assert_eq!(RECEIPT_BYTES, 41);
    assert_eq!(ORDER_BYTES_WITHOUT_RECEIPT, 286);
    assert_eq!(ORDER_MAX_BYTES, 327);
    assert_eq!(UserNonce::INIT_SPACE, USER_NONCE_BYTES);
    assert_eq!(AcceptedReceipt::INIT_SPACE, RECEIPT_BYTES);
    assert_eq!(OrderState::INIT_SPACE, 1);
    assert_eq!(Order::INIT_SPACE, ORDER_MAX_BYTES);
    assert_eq!(UserNonce::DISCRIMINATOR.len() + UserNonce::INIT_SPACE, 81);
    assert_eq!(Order::DISCRIMINATOR.len() + Order::INIT_SPACE, 335);
}

#[test]
fn account_discriminators_are_eight_bytes_and_distinct() {
    assert_eq!(UserNonce::DISCRIMINATOR.len(), 8);
    assert_eq!(Order::DISCRIMINATOR.len(), 8);
    assert_ne!(UserNonce::DISCRIMINATOR, Order::DISCRIMINATOR);
}

#[test]
fn nonce_account_round_trips_with_discriminator() {
    let counter = nonce_fixture(u64::MAX);
    let mut bytes = Vec::new();
    counter.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), 8 + USER_NONCE_BYTES);
    assert_eq!(&bytes[..8], UserNonce::DISCRIMINATOR);
    assert_eq!(
        UserNonce::try_deserialize(&mut bytes.as_slice()).unwrap(),
        counter
    );
}

#[test]
fn optional_receipt_round_trips_in_maximum_account_space() {
    let mut order = order_fixture();
    for receipt in [None, Some(receipt_fixture())] {
        order.accepted_receipt = receipt;
        let mut bytes = Vec::new();
        order.try_serialize(&mut bytes).unwrap();
        let expected_payload =
            ORDER_BYTES_WITHOUT_RECEIPT + if receipt.is_some() { RECEIPT_BYTES } else { 0 };
        assert_eq!(bytes.len(), 8 + expected_payload);
        assert_eq!(&bytes[..8], Order::DISCRIMINATOR);
        // Model only the allocated byte buffer, not on-chain account persistence.
        let mut allocated = vec![0; 8 + Order::INIT_SPACE];
        assert!(bytes.len() <= allocated.len());
        allocated[..bytes.len()].copy_from_slice(&bytes);
        let restored = Order::try_deserialize(&mut allocated.as_slice()).unwrap();
        assert_eq!(restored, order);
        assert_eq!(restored.accepted_receipt, receipt);
    }
}

#[test]
fn source_state_tags_and_terminal_cancellation_flag_round_trip() {
    for (tag, state) in [
        (0, OrderState::Pending),
        (1, OrderState::CancelRequested),
        (2, OrderState::Settled),
        (3, OrderState::Refunded),
    ] {
        let mut bytes = Vec::new();
        state.serialize(&mut bytes).unwrap();
        assert_eq!(bytes, vec![tag]);
        assert_eq!(OrderState::try_from_slice(&bytes).unwrap(), state);

        // Storage fixtures only; no transition or receipt validation is executed.
        let mut order = order_fixture();
        order.state = state;
        order.cancellation_requested = state != OrderState::Pending;
        order.accepted_receipt = match state {
            OrderState::Settled => Some(receipt_fixture()),
            OrderState::Refunded => Some(AcceptedReceipt {
                terminal: 2,
                filled_quantity: 0,
                receipt_hash: [0xd2; 32],
            }),
            _ => None,
        };
        let mut bytes = Vec::new();
        order.try_serialize(&mut bytes).unwrap();
        let restored = Order::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(restored, order);
        if matches!(state, OrderState::Settled | OrderState::Refunded) {
            assert!(restored.cancellation_requested);
            assert!(restored.accepted_receipt.is_some());
        }
    }
}

#[test]
fn reconstructed_terms_use_config_domain_and_stored_order_fields() {
    let config = config_fixture();
    let mut order = order_fixture();
    // Deliberately differ from Config: reconstruction does not authorize these terms.
    order.outcome = 1;
    assert_ne!(order.market, config.market);
    assert_ne!(order.outcome, config.outcome);
    assert_eq!(
        order.terms(&config),
        Terms {
            identity: Identity {
                domain: Domain {
                    source_domain: [0xa1; 32],
                    destination_domain: [0xa2; 32],
                    solana_program: settlement_lab::ID.to_bytes(),
                    chain_id: [0xa3; 32],
                    settlement: [0xa4; 20],
                },
                user: [0x55; 32],
                nonce: 7,
            },
            market: [0x66; 32],
            outcome: 1,
            cash_amount: 10_000_000,
            minimum_shares: 20_000_000,
        }
    );
}

fn hex<const N: usize>(literal: &str) -> [u8; N] {
    assert_eq!(literal.len(), N * 2);
    let mut bytes = [0; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&literal[2 * i..2 * i + 2], 16).unwrap();
    }
    bytes
}

#[test]
fn spec_encoding_fixture_reproduces_existing_hashes() {
    // SPEC repeated-byte encoding values are not a valid deployed configuration,
    // signer, or PDA. Keep these domain replacements local to the golden test.
    let mut spec_config = config_fixture();
    spec_config.source_domain = [0x11; 32];
    spec_config.destination_domain = [0x22; 32];
    spec_config.solana_program = key(0x33);
    spec_config.chain_id = hex("0000000000000000000000000000000000000000000000000000000000007a69");
    spec_config.settlement = [0x44; 20];
    spec_config.market = [0x66; 32];
    let mut order = order_fixture();
    order.order_id = hex("bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7");
    order.terms_hash = hex("081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8");
    let terms = order.terms(&spec_config);
    assert_eq!(order_id(&terms.identity), order.order_id);
    assert_eq!(terms_hash(&terms), order.terms_hash);
}

#[test]
fn changed_stored_economics_change_terms_hash_only() {
    let config = config_fixture();
    let order = order_fixture();
    let original = order.terms(&config);
    let mut variants = [order.clone(), order.clone(), order.clone(), order.clone()];
    variants[0].market[0] ^= 1;
    variants[1].outcome = 1;
    variants[2].cash_amount += 1;
    variants[3].minimum_shares += 1;
    for changed in variants {
        let terms = changed.terms(&config);
        assert_eq!(order_id(&terms.identity), order_id(&original.identity));
        assert_ne!(terms_hash(&terms), terms_hash(&original));
    }
}

#[test]
fn every_changed_config_domain_field_changes_both_hashes() {
    let config = config_fixture();
    let order = order_fixture();
    let original = order.terms(&config);
    let mut variants = [
        config.clone(),
        config.clone(),
        config.clone(),
        config.clone(),
        config.clone(),
    ];
    variants[0].source_domain[0] ^= 1;
    variants[1].destination_domain[0] ^= 1;
    variants[2].solana_program = key(0xef);
    variants[3].chain_id[0] ^= 1;
    variants[4].settlement[0] ^= 1;
    for changed in variants {
        let terms = order.terms(&changed);
        assert_ne!(order_id(&terms.identity), order_id(&original.identity));
        assert_ne!(terms_hash(&terms), terms_hash(&original));
    }
}
