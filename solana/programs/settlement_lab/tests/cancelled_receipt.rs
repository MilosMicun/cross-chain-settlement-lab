use anchor_lang::{prelude::Pubkey, AccountSerialize};
use settlement_lab::{
    cancelled_receipt::{validate_cancelled_receipt, CancelledDecision, CancelledReceiptError},
    configuration::Config,
    order_state::{AcceptedReceipt, Order, OrderState, ValidationError},
    protocol_encoding::{
        order_id, receipt_bytes, receipt_hash, terms_hash, Domain, Identity, Receipt, Terms,
    },
};

const STATES: [OrderState; 4] = [
    OrderState::Pending,
    OrderState::CancelRequested,
    OrderState::Settled,
    OrderState::Refunded,
];
const MAX_CASH: u64 = 9_223_372_036_854_775_807;
const GOLDEN_ORDER_ID: &str = "bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7";
const GOLDEN_TERMS_HASH: &str = "081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8";
const GOLDEN_FILLED_HASH: &str = "beb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888";
const GOLDEN_CANCELLED_HASH: &str =
    "acc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b";
const GOLDEN_CANCELLED_BYTES: &str = concat!(
    "4343534c52433031",
    "081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8",
    "02",
    "0000000000000000",
);

fn hex<const N: usize>(literal: &str) -> [u8; N] {
    assert_eq!(literal.len(), 2 * N);
    let mut bytes = [0; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&literal[2 * index..2 * index + 2], 16).unwrap();
    }
    bytes
}

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

struct Fixture {
    config_key: Pubkey,
    config: Config,
    order: Order,
    terms: Terms,
    receipt: Receipt,
}

fn golden_cancelled() -> AcceptedReceipt {
    AcceptedReceipt {
        terminal: 2,
        filled_quantity: 0,
        receipt_hash: hex(GOLDEN_CANCELLED_HASH),
    }
}

// Independent SPEC encoding fixtures, not deployed accounts or authorized
// signers. Synthetic terminal records do not prove on-chain refund behavior,
// signer authorization, account ownership, or EVM execution/finality.
fn fixture(state: OrderState) -> Fixture {
    let config_key = key(0xc1);
    let chain_id = hex("0000000000000000000000000000000000000000000000000000000000007a69");
    let config = Config {
        version: 1,
        source_domain: [0x11; 32],
        destination_domain: [0x22; 32],
        solana_program: key(0x33),
        chain_id,
        settlement: [0x44; 20],
        venue: [0xa5; 20],
        cash_token: [0xa6; 20],
        yes_token: [0xa7; 20],
        evm_operator: [0xa8; 20],
        evm_executor: [0xa9; 20],
        market: [0x66; 32],
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
    };
    // Supplied terms are constructed independently of Order::terms.
    let terms = Terms {
        identity: Identity {
            domain: Domain {
                source_domain: [0x11; 32],
                destination_domain: [0x22; 32],
                solana_program: [0x33; 32],
                chain_id,
                settlement: [0x44; 20],
            },
            user: [0x55; 32],
            nonce: 7,
        },
        market: [0x66; 32],
        outcome: 0,
        cash_amount: 10_000_000,
        minimum_shares: 20_000_000,
    };
    let order = Order {
        config: config_key,
        user: key(0x55),
        nonce: 7,
        market: [0x66; 32],
        outcome: 0,
        cash_amount: 10_000_000,
        minimum_shares: 20_000_000,
        order_id: hex(GOLDEN_ORDER_ID),
        terms_hash: hex(GOLDEN_TERMS_HASH),
        user_cash_ata: key(0xc4),
        user_yes_ata: key(0xc5),
        escrow: key(0xc6),
        state,
        cancellation_requested: matches!(state, OrderState::CancelRequested | OrderState::Refunded),
        accepted_receipt: match state {
            OrderState::Settled => Some(AcceptedReceipt {
                terminal: 1,
                filled_quantity: 20_000_000,
                receipt_hash: hex(GOLDEN_FILLED_HASH),
            }),
            OrderState::Refunded => Some(golden_cancelled()),
            _ => None,
        },
        bump: 252,
        escrow_bump: 251,
    };
    let receipt = Receipt {
        terms_hash: hex(GOLDEN_TERMS_HASH),
        terminal: 2,
        filled_quantity: 0,
    };
    Fixture {
        config_key,
        config,
        order,
        terms,
        receipt,
    }
}

fn accepted(receipt: &Receipt) -> AcceptedReceipt {
    AcceptedReceipt {
        terminal: receipt.terminal,
        filled_quantity: receipt.filled_quantity,
        receipt_hash: receipt_hash(receipt).unwrap(),
    }
}

// Only changed, nongolden fixtures use encoders to maintain unrelated bindings.
fn refresh_terms(f: &mut Fixture) {
    f.terms = f.order.terms(&f.config);
    f.order.order_id = order_id(&f.terms.identity);
    f.order.terms_hash = terms_hash(&f.terms);
    f.receipt.terms_hash = f.order.terms_hash;
    if f.order.accepted_receipt.is_some() {
        rehash_retained(f);
    }
}

fn rehash_retained(f: &mut Fixture) {
    let retained = f.order.accepted_receipt.as_mut().unwrap();
    retained.receipt_hash = receipt_hash(&Receipt {
        terms_hash: f.order.terms_hash,
        terminal: retained.terminal,
        filled_quantity: retained.filled_quantity,
    })
    .unwrap();
}

fn bytes(account: &impl AccountSerialize) -> Vec<u8> {
    let mut bytes = Vec::new();
    account.try_serialize(&mut bytes).unwrap();
    bytes
}

// All validator calls pass through this helper, including errors. Serialization
// covers every Config/Order field and discriminator, recipients, bumps, and
// retained history. Supplied terms and receipt are also checked for immutability.
fn check(f: &Fixture, expected: Result<CancelledDecision, CancelledReceiptError>) {
    let before_order = bytes(&f.order);
    let before_config = bytes(&f.config);
    let before_terms = f.terms;
    let before_receipt = f.receipt;
    let result =
        validate_cancelled_receipt(f.config_key, &f.config, &f.order, &f.terms, &f.receipt);
    assert_eq!(bytes(&f.order), before_order);
    assert_eq!(bytes(&f.config), before_config);
    assert_eq!(f.terms, before_terms);
    assert_eq!(f.receipt, before_receipt);
    assert_eq!(result, expected);
}

#[test]
fn cancel_requested_applies_exact_spec_receipt_without_mutation() {
    let f = fixture(OrderState::CancelRequested);
    assert_eq!(
        receipt_bytes(&f.receipt),
        Ok(hex::<49>(GOLDEN_CANCELLED_BYTES))
    );
    check(&f, Ok(CancelledDecision::Apply(golden_cancelled())));
}

#[test]
fn consistent_pending_requires_prior_user_cancellation() {
    check(
        &fixture(OrderState::Pending),
        Err(CancelledReceiptError::CancellationNotRequested),
    );
}

#[test]
fn consistent_refunded_replays_exact_literal_receipt() {
    check(
        &fixture(OrderState::Refunded),
        Ok(CancelledDecision::Replay),
    );
}

#[test]
fn consistent_settled_conflicts_regardless_of_cancellation_history() {
    for flag in [false, true] {
        let mut f = fixture(OrderState::Settled);
        f.order.cancellation_requested = flag;
        check(&f, Err(CancelledReceiptError::TerminalConflict));
    }
}

#[test]
fn unattainable_positive_minimum_allows_apply_and_refund_replay() {
    for state in [OrderState::CancelRequested, OrderState::Refunded] {
        for minimum in [20_000_001, u64::MAX] {
            let mut f = fixture(state);
            f.order.minimum_shares = minimum;
            refresh_terms(&mut f);
            let expected = if state == OrderState::Refunded {
                CancelledDecision::Replay
            } else {
                CancelledDecision::Apply(accepted(&f.receipt))
            };
            check(&f, Ok(expected));
        }
    }
}

#[test]
fn unsupported_config_versions_reject_in_every_state() {
    for state in STATES {
        for version in [0, 2, u8::MAX] {
            let mut f = fixture(state);
            f.config.version = version;
            check(
                &f,
                Err(CancelledReceiptError::UnsupportedConfigVersion(version)),
            );
        }
    }
}

#[test]
fn wrong_config_key_or_stored_link_rejects_in_every_state() {
    for state in STATES {
        let mut f = fixture(state);
        f.config_key = key(0xe1);
        check(&f, Err(CancelledReceiptError::ConfigMismatch));
        let mut f = fixture(state);
        f.order.config = key(0xe2);
        check(&f, Err(CancelledReceiptError::ConfigMismatch));
    }
}

#[test]
fn market_and_yes_outcome_must_match_config() {
    for state in STATES {
        for changed in 0..5 {
            let mut f = fixture(state);
            match changed {
                0 => f.order.market[0] ^= 1,
                1 => f.config.market[0] ^= 1,
                2 => f.order.outcome = 1,
                3 => f.config.outcome = 1,
                4 => {
                    f.order.outcome = 1;
                    f.config.outcome = 1;
                }
                _ => unreachable!(),
            }
            refresh_terms(&mut f);
            check(&f, Err(CancelledReceiptError::MarketOutcomeMismatch));
        }
    }
}

#[test]
fn every_supplied_user_nonce_and_economic_field_is_bound() {
    for state in STATES {
        let original = fixture(state).terms;
        let mut variants = [original; 6];
        variants[0].identity.user[0] ^= 1;
        variants[1].identity.nonce += 1;
        variants[2].market[0] ^= 1;
        variants[3].outcome = 1;
        variants[4].cash_amount += 1;
        variants[5].minimum_shares += 1;
        for terms in variants {
            let mut f = fixture(state);
            f.terms = terms;
            check(&f, Err(CancelledReceiptError::TermsMismatch));
        }
    }
}

#[test]
fn all_supplied_domain_fields_and_all_chain_id_bytes_are_bound() {
    for state in STATES {
        let original = fixture(state).terms;
        let mut variants = vec![original; 4];
        variants[0].identity.domain.source_domain[0] ^= 1;
        variants[1].identity.domain.destination_domain[0] ^= 1;
        variants[2].identity.domain.solana_program[0] ^= 1;
        variants[3].identity.domain.settlement[0] ^= 1;
        for index in 0..32 {
            let mut terms = original;
            terms.identity.domain.chain_id[index] ^= 1;
            variants.push(terms);
        }
        for terms in variants {
            let mut f = fixture(state);
            f.terms = terms;
            check(&f, Err(CancelledReceiptError::TermsMismatch));
        }
    }
}

#[test]
fn changed_config_domain_cannot_reuse_stored_identity() {
    for state in STATES {
        for changed in 0..5 {
            let mut f = fixture(state);
            match changed {
                0 => f.config.source_domain[0] ^= 1,
                1 => f.config.destination_domain[0] ^= 1,
                2 => f.config.solana_program = key(0xe3),
                3 => f.config.chain_id[0] ^= 1,
                4 => f.config.settlement[0] ^= 1,
                _ => unreachable!(),
            }
            f.terms = f.order.terms(&f.config);
            check(&f, Err(CancelledReceiptError::InvalidStoredOrderId));
        }
    }
}

#[test]
fn incorrect_stored_order_id_rejects_in_every_state() {
    for state in STATES {
        for index in 0..32 {
            let mut f = fixture(state);
            f.order.order_id[index] ^= 1;
            check(&f, Err(CancelledReceiptError::InvalidStoredOrderId));
        }
    }
}

#[test]
fn incorrect_stored_terms_hash_cannot_be_laundered_by_receipts() {
    for state in STATES {
        for index in 0..32 {
            let mut f = fixture(state);
            f.order.terms_hash[index] ^= 1;
            f.receipt.terms_hash = f.order.terms_hash;
            if f.order.accepted_receipt.is_some() {
                rehash_retained(&mut f);
            }
            check(&f, Err(CancelledReceiptError::InvalidStoredTermsHash));
        }
    }
}

#[test]
fn incorrect_incoming_terms_hash_rejects_in_every_state() {
    for state in STATES {
        for index in 0..32 {
            let mut f = fixture(state);
            f.receipt.terms_hash[index] ^= 1;
            check(&f, Err(CancelledReceiptError::ReceiptTermsHashMismatch));
        }
    }
}

#[test]
fn every_incoming_terminal_except_cancelled_rejects() {
    for state in STATES {
        let mut rejected = 0;
        for terminal in u8::MIN..=u8::MAX {
            if terminal == 2 {
                continue;
            }
            let mut f = fixture(state);
            f.receipt.terminal = terminal;
            check(
                &f,
                Err(CancelledReceiptError::InvalidCancelledTerminal(terminal)),
            );
            rejected += 1;
        }
        assert_eq!(rejected, 255);
    }
}

#[test]
fn nonzero_incoming_cancelled_quantities_reject_in_every_state() {
    for state in STATES {
        for quantity in [1, 20_000_000, u64::MAX] {
            let mut f = fixture(state);
            f.receipt.filled_quantity = quantity;
            check(
                &f,
                Err(CancelledReceiptError::NonzeroCancelledQuantity(quantity)),
            );
        }
    }
}

#[test]
fn all_inconsistent_nonterminal_flag_and_receipt_combinations_reject() {
    let filled = fixture(OrderState::Settled).order.accepted_receipt;
    let cancelled = fixture(OrderState::Refunded).order.accepted_receipt;
    for state in [OrderState::Pending, OrderState::CancelRequested] {
        for flag in [false, true] {
            for retained in [None, filled, cancelled] {
                if retained.is_none() && flag == (state == OrderState::CancelRequested) {
                    continue;
                }
                let mut f = fixture(state);
                f.order.cancellation_requested = flag;
                f.order.accepted_receipt = retained;
                check(&f, Err(CancelledReceiptError::InconsistentRecord));
            }
        }
    }
}

#[test]
fn terminal_states_require_retained_receipts_for_both_flags() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for flag in [false, true] {
            let mut f = fixture(state);
            f.order.cancellation_requested = flag;
            f.order.accepted_receipt = None;
            check(&f, Err(CancelledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn refunded_without_cancellation_intent_is_inconsistent() {
    let mut f = fixture(OrderState::Refunded);
    f.order.cancellation_requested = false;
    check(&f, Err(CancelledReceiptError::InconsistentRecord));
}

#[test]
fn retained_wrong_or_unsupported_terminal_is_inconsistent() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for terminal in u8::MIN..=u8::MAX {
            let mut f = fixture(state);
            let retained = f.order.accepted_receipt.as_mut().unwrap();
            if terminal == retained.terminal {
                continue;
            }
            retained.terminal = terminal;
            if terminal == 1 || terminal == 2 {
                // A canonical hash cannot legitimize an opposite terminal tag.
                rehash_retained(&mut f);
            }
            check(&f, Err(CancelledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn retained_wrong_quantities_are_inconsistent_even_with_canonical_hashes() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for quantity in [0, 1, 19_999_999, 20_000_000, 20_000_001, u64::MAX] {
            let mut f = fixture(state);
            let retained = f.order.accepted_receipt.as_mut().unwrap();
            if quantity == retained.filled_quantity {
                continue;
            }
            retained.filled_quantity = quantity;
            rehash_retained(&mut f);
            check(&f, Err(CancelledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn corrupt_retained_hashes_are_neither_replays_nor_terminal_conflicts() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for index in 0..32 {
            let mut f = fixture(state);
            f.order.accepted_receipt.as_mut().unwrap().receipt_hash[index] ^= 1;
            check(&f, Err(CancelledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn settled_fill_below_retained_minimum_is_inconsistent_for_both_flags() {
    for flag in [false, true] {
        for minimum in [20_000_001, u64::MAX] {
            let mut f = fixture(OrderState::Settled);
            f.order.cancellation_requested = flag;
            f.order.minimum_shares = minimum;
            refresh_terms(&mut f);
            check(&f, Err(CancelledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn valid_cash_and_minimum_boundaries_allow_apply_and_refund_replay() {
    for state in [OrderState::CancelRequested, OrderState::Refunded] {
        for cash in [1, MAX_CASH] {
            for minimum in [1, cash * 2, u64::MAX] {
                let mut f = fixture(state);
                f.order.cash_amount = cash;
                f.order.minimum_shares = minimum;
                refresh_terms(&mut f);
                let expected = if state == OrderState::Refunded {
                    CancelledDecision::Replay
                } else {
                    CancelledDecision::Apply(accepted(&f.receipt))
                };
                check(&f, Ok(expected));
            }
        }
    }
}

#[test]
fn invalid_stored_cash_or_zero_minimum_prevents_any_decision() {
    for state in STATES {
        for (cash, minimum, error) in [
            (0, 1, ValidationError::ZeroCash),
            (MAX_CASH + 1, 1, ValidationError::CashTooLarge),
            (u64::MAX, 1, ValidationError::CashTooLarge),
            (1, 0, ValidationError::ZeroMinimum),
            (0, 0, ValidationError::ZeroCash),
            (MAX_CASH + 1, 0, ValidationError::CashTooLarge),
        ] {
            let mut f = fixture(state);
            f.order.cash_amount = cash;
            f.order.minimum_shares = minimum;
            refresh_terms(&mut f);
            check(&f, Err(CancelledReceiptError::InvalidStoredAmounts(error)));
        }
    }
}

#[test]
fn combined_invalid_inputs_demonstrate_complete_validation_precedence() {
    use CancelledReceiptError::*;
    let expected = [
        UnsupportedConfigVersion(2),
        ConfigMismatch,
        MarketOutcomeMismatch,
        InvalidStoredAmounts(ValidationError::ZeroCash),
        TermsMismatch,
        InvalidStoredOrderId,
        InvalidStoredTermsHash,
        InconsistentRecord,
        ReceiptTermsHashMismatch,
        InvalidCancelledTerminal(1),
        NonzeroCancelledQuantity(1),
        CancellationNotRequested,
    ];
    // Repair one validation stage at a time, leaving every later stage invalid.
    for (stage, error) in expected.into_iter().enumerate() {
        let mut f = fixture(OrderState::Pending);
        if stage == 0 {
            f.config.version = 2;
        }
        if stage <= 1 {
            f.config_key = key(0xe1);
        }
        if stage <= 2 {
            f.order.market[0] ^= 1;
        }
        if stage <= 3 {
            f.order.cash_amount = 0;
        }
        if stage <= 4 {
            f.terms.identity.user[0] ^= 1;
        }
        if stage <= 5 {
            f.order.order_id[0] ^= 1;
        }
        if stage <= 6 {
            f.order.terms_hash[0] ^= 1;
        }
        if stage <= 7 {
            f.order.cancellation_requested = true;
        }
        if stage <= 8 {
            f.receipt.terms_hash[0] ^= 1;
        }
        if stage <= 9 {
            f.receipt.terminal = 1;
        }
        if stage <= 10 {
            f.receipt.filled_quantity = 1;
        }
        check(&f, Err(error));
    }
}

#[test]
fn corrupt_terminal_records_precede_invalid_incoming_receipts() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        let mut f = fixture(state);
        f.order.accepted_receipt.as_mut().unwrap().receipt_hash[0] ^= 1;
        f.receipt.terms_hash[0] ^= 1;
        f.receipt.terminal = 0;
        f.receipt.filled_quantity = 1;
        check(&f, Err(CancelledReceiptError::InconsistentRecord));
    }
}

#[test]
fn incoming_receipt_errors_precede_eligibility_replay_and_conflict() {
    for state in STATES {
        let mut f = fixture(state);
        f.receipt.terms_hash[0] ^= 1;
        f.receipt.terminal = 0;
        f.receipt.filled_quantity = 1;
        check(&f, Err(CancelledReceiptError::ReceiptTermsHashMismatch));
        f.receipt.terms_hash = hex(GOLDEN_TERMS_HASH);
        check(&f, Err(CancelledReceiptError::InvalidCancelledTerminal(0)));
        f.receipt.terminal = 2;
        check(&f, Err(CancelledReceiptError::NonzeroCancelledQuantity(1)));
    }
}
