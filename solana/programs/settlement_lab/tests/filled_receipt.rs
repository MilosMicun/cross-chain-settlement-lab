use anchor_lang::{prelude::Pubkey, AccountSerialize};
use settlement_lab::{
    configuration::Config,
    filled_receipt::{validate_filled_receipt, FilledDecision, FilledReceiptError},
    order_state::{AcceptedReceipt, Order, OrderState, ValidationError},
    protocol_encoding::{order_id, receipt_hash, terms_hash, Receipt, Terms},
};

const STATES: [OrderState; 4] = [
    OrderState::Pending,
    OrderState::CancelRequested,
    OrderState::Settled,
    OrderState::Refunded,
];
const MAX_CASH: u64 = 9_223_372_036_854_775_807;
const MAX_OUTPUT: u64 = 18_446_744_073_709_551_614;

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

// Host data only: even the actual program ID does not establish deployment,
// account ownership, canonical PDAs, signer authorization, or token validity.
fn fixture(state: OrderState) -> Fixture {
    let config_key = key(0xc1);
    let config = Config {
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
    let mut order = Order {
        config: config_key,
        user: key(0x55),
        nonce: 7,
        market: [0x66; 32],
        outcome: 0,
        cash_amount: 10_000_000,
        minimum_shares: 20_000_000,
        order_id: [0; 32],
        terms_hash: [0; 32],
        user_cash_ata: key(0xc4),
        user_yes_ata: key(0xc5),
        escrow: key(0xc6),
        state,
        cancellation_requested: matches!(state, OrderState::CancelRequested | OrderState::Refunded),
        accepted_receipt: None,
        bump: 252,
        escrow_bump: 251,
    };
    let terms = order.terms(&config);
    order.order_id = order_id(&terms.identity);
    order.terms_hash = terms_hash(&terms);
    let receipt = Receipt {
        terms_hash: order.terms_hash,
        terminal: 1,
        filled_quantity: 20_000_000,
    };
    if state == OrderState::Settled {
        order.accepted_receipt = Some(accepted(&receipt));
    } else if state == OrderState::Refunded {
        order.accepted_receipt = Some(accepted(&Receipt {
            terminal: 2,
            filled_quantity: 0,
            ..receipt
        }));
    }
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

// Refresh fixture hashes after intentional stored-data changes, so the test can
// isolate amount/lifecycle validation instead of failing on an unrelated hash.
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

// Every validator call, successful or rejected, checks the entire serialized
// Order (including discriminator, recipients, bumps, state, flag, and receipt).
fn check(f: &Fixture, expected: Result<FilledDecision, FilledReceiptError>) {
    let before_order = bytes(&f.order);
    let before_config = bytes(&f.config);
    let before_terms = f.terms;
    let before_receipt = f.receipt;
    let result = validate_filled_receipt(f.config_key, &f.config, &f.order, &f.terms, &f.receipt);
    assert_eq!(bytes(&f.order), before_order);
    assert_eq!(bytes(&f.config), before_config);
    assert_eq!(f.terms, before_terms);
    assert_eq!(f.receipt, before_receipt);
    assert_eq!(result, expected);
}

#[test]
fn pending_returns_apply_without_advancing_state() {
    let f = fixture(OrderState::Pending);
    check(&f, Ok(FilledDecision::Apply(accepted(&f.receipt))));
}

#[test]
fn cancellation_request_does_not_block_completed_fill() {
    let f = fixture(OrderState::CancelRequested);
    check(&f, Ok(FilledDecision::Apply(accepted(&f.receipt))));
}

#[test]
fn settled_exact_replay_preserves_both_cancellation_histories() {
    for flag in [false, true] {
        let mut f = fixture(OrderState::Settled);
        f.order.cancellation_requested = flag;
        check(&f, Ok(FilledDecision::Replay));
    }
}

#[test]
fn legitimate_refund_rejects_fill_as_terminal_conflict() {
    check(
        &fixture(OrderState::Refunded),
        Err(FilledReceiptError::TerminalConflict),
    );
}

#[test]
fn all_inconsistent_nonterminal_flag_receipt_combinations_reject() {
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
                check(&f, Err(FilledReceiptError::InconsistentRecord));
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
            check(&f, Err(FilledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn refunded_without_user_cancellation_is_inconsistent() {
    let mut f = fixture(OrderState::Refunded);
    f.order.cancellation_requested = false;
    check(&f, Err(FilledReceiptError::InconsistentRecord));
}

#[test]
fn retained_wrong_or_unsupported_terminals_are_inconsistent() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for terminal in u8::MIN..=u8::MAX {
            let mut f = fixture(state);
            let retained = f.order.accepted_receipt.as_mut().unwrap();
            if terminal == retained.terminal {
                continue;
            }
            retained.terminal = terminal;
            if terminal == 1 || terminal == 2 {
                // A canonical hash cannot make the opposite terminal legitimate.
                rehash_retained(&mut f);
            }
            check(&f, Err(FilledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn retained_wrong_quantities_reject_even_with_canonical_hashes() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for quantity in [0, 1, 19_999_999, 20_000_000, 20_000_001, u64::MAX] {
            let mut f = fixture(state);
            let retained = f.order.accepted_receipt.as_mut().unwrap();
            if quantity == retained.filled_quantity {
                continue;
            }
            retained.filled_quantity = quantity;
            rehash_retained(&mut f);
            check(&f, Err(FilledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn corrupt_retained_hashes_reject_for_both_terminal_states() {
    for state in [OrderState::Settled, OrderState::Refunded] {
        for index in 0..32 {
            let mut f = fixture(state);
            f.order.accepted_receipt.as_mut().unwrap().receipt_hash[index] ^= 1;
            check(&f, Err(FilledReceiptError::InconsistentRecord));
        }
    }
}

#[test]
fn settled_retained_fill_below_minimum_is_inconsistent() {
    let mut f = fixture(OrderState::Settled);
    f.order.minimum_shares = 20_000_001;
    refresh_terms(&mut f);
    check(&f, Err(FilledReceiptError::InconsistentRecord));
}

#[test]
fn unsupported_config_versions_reject_before_apply_replay_or_conflict() {
    for state in STATES {
        for version in [0, 2, u8::MAX] {
            let mut f = fixture(state);
            f.config.version = version;
            check(
                &f,
                Err(FilledReceiptError::UnsupportedConfigVersion(version)),
            );
        }
    }
}

#[test]
fn supplied_config_key_and_stored_relationship_must_agree() {
    for state in STATES {
        let mut f = fixture(state);
        f.config_key = key(0xe1);
        check(&f, Err(FilledReceiptError::ConfigMismatch));
        let mut f = fixture(state);
        f.order.config = key(0xe2);
        check(&f, Err(FilledReceiptError::ConfigMismatch));
    }
}

#[test]
fn stored_market_and_yes_outcome_must_match_config() {
    for state in STATES {
        for changed in 0..4 {
            let mut f = fixture(state);
            match changed {
                0 => f.order.market[0] ^= 1,
                1 => f.order.outcome = 1,
                2 => f.config.outcome = 1,
                3 => {
                    f.order.outcome = 1;
                    f.config.outcome = 1;
                }
                _ => unreachable!(),
            }
            refresh_terms(&mut f);
            check(&f, Err(FilledReceiptError::MarketOutcomeMismatch));
        }
    }
}

#[test]
fn every_changed_supplied_user_nonce_or_economic_field_rejects() {
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
            // Incoming receipt still carries the correct stored hash. Full terms
            // must be compared even when all supplied/stored hash fields agree.
            check(&f, Err(FilledReceiptError::TermsMismatch));
        }
    }
}

#[test]
fn every_changed_supplied_domain_field_rejects_including_full_chain_id() {
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
            check(&f, Err(FilledReceiptError::TermsMismatch));
        }
    }
}

#[test]
fn changed_config_domain_cannot_validate_old_stored_identity() {
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
            check(&f, Err(FilledReceiptError::InvalidStoredOrderId));
        }
    }
}

#[test]
fn incorrect_stored_order_id_or_terms_hash_rejects() {
    for state in STATES {
        let mut f = fixture(state);
        f.order.order_id[0] ^= 1;
        check(&f, Err(FilledReceiptError::InvalidStoredOrderId));
        let mut f = fixture(state);
        f.order.terms_hash[0] ^= 1;
        f.receipt.terms_hash = f.order.terms_hash;
        if f.order.accepted_receipt.is_some() {
            rehash_retained(&mut f);
        }
        check(&f, Err(FilledReceiptError::InvalidStoredTermsHash));
    }
}

#[test]
fn incorrect_incoming_receipt_terms_hash_is_not_a_terminal_conflict() {
    for state in STATES {
        let mut f = fixture(state);
        f.receipt.terms_hash[0] ^= 1;
        check(&f, Err(FilledReceiptError::ReceiptTermsHashMismatch));
    }
}

#[test]
fn cancelled_and_all_unsupported_incoming_tags_are_invalid_filled_inputs() {
    for state in STATES {
        for terminal in u8::MIN..=u8::MAX {
            if terminal == 1 {
                continue;
            }
            let mut f = fixture(state);
            f.receipt.terminal = terminal;
            if terminal == 2 {
                f.receipt.filled_quantity = 0;
            }
            check(&f, Err(FilledReceiptError::InvalidFilledTerminal(terminal)));
        }
    }
}

#[test]
fn zero_smaller_and_larger_incoming_quantities_are_invalid_economics() {
    for state in STATES {
        for quantity in [0, 1, 19_999_999, 20_000_001, u64::MAX] {
            let mut f = fixture(state);
            f.receipt.filled_quantity = quantity;
            check(
                &f,
                Err(FilledReceiptError::InvalidFilledQuantity {
                    expected: 20_000_000,
                    actual: quantity,
                }),
            );
        }
    }
}

#[test]
fn unattainable_minimum_rejects_fill_but_does_not_corrupt_cancelled_record() {
    for state in [
        OrderState::Pending,
        OrderState::CancelRequested,
        OrderState::Refunded,
    ] {
        for minimum in [20_000_001, u64::MAX] {
            let mut f = fixture(state);
            f.order.minimum_shares = minimum;
            refresh_terms(&mut f);
            // Creation permits this minimum; a retained Cancelled/zero record is
            // still consistent, but the incoming fill fails its own economics.
            check(&f, Err(FilledReceiptError::MinimumNotMet));
        }
    }
}

#[test]
fn smallest_and_largest_valid_cash_output_boundaries_apply_and_replay() {
    for (cash, output) in [(1, 2), (MAX_CASH, MAX_OUTPUT)] {
        for minimum in [1, output] {
            for state in [
                OrderState::Pending,
                OrderState::CancelRequested,
                OrderState::Settled,
            ] {
                let mut f = fixture(state);
                f.order.cash_amount = cash;
                f.order.minimum_shares = minimum;
                refresh_terms(&mut f);
                f.receipt.filled_quantity = output;
                if state == OrderState::Settled {
                    f.order.accepted_receipt = Some(accepted(&f.receipt));
                    for flag in [false, true] {
                        f.order.cancellation_requested = flag;
                        check(&f, Ok(FilledDecision::Replay));
                    }
                } else {
                    check(&f, Ok(FilledDecision::Apply(accepted(&f.receipt))));
                }
            }
        }
    }
}

#[test]
fn largest_cash_cannot_satisfy_maximum_u64_minimum() {
    let mut f = fixture(OrderState::Pending);
    f.order.cash_amount = MAX_CASH;
    f.order.minimum_shares = u64::MAX;
    refresh_terms(&mut f);
    f.receipt.filled_quantity = MAX_OUTPUT;
    check(&f, Err(FilledReceiptError::MinimumNotMet));
}

#[test]
fn invalid_stored_cash_and_zero_minimum_reject_before_any_decision() {
    for state in STATES {
        for (cash, minimum, error) in [
            (0, 1, ValidationError::ZeroCash),
            (MAX_CASH + 1, 1, ValidationError::CashTooLarge),
            (u64::MAX, 1, ValidationError::CashTooLarge),
            (1, 0, ValidationError::ZeroMinimum),
        ] {
            let mut f = fixture(state);
            f.order.cash_amount = cash;
            f.order.minimum_shares = minimum;
            refresh_terms(&mut f);
            check(&f, Err(FilledReceiptError::InvalidStoredAmounts(error)));
        }
    }
}

fn hex<const N: usize>(literal: &str) -> [u8; N] {
    assert_eq!(literal.len(), 2 * N);
    let mut bytes = [0; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&literal[2 * index..2 * index + 2], 16).unwrap();
    }
    bytes
}

#[test]
fn spec_golden_receipt_hash_is_literal_for_apply_and_replay() {
    // Fictional SPEC encoding fixture, deliberately separate from deployment and
    // account authorization. Its repeated-byte program is not this program ID.
    let mut f = fixture(OrderState::Pending);
    f.config.source_domain = [0x11; 32];
    f.config.destination_domain = [0x22; 32];
    f.config.solana_program = key(0x33);
    f.config.chain_id = hex("0000000000000000000000000000000000000000000000000000000000007a69");
    f.config.settlement = [0x44; 20];
    f.terms = f.order.terms(&f.config);
    f.order.order_id = hex("bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7");
    f.order.terms_hash = hex("081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8");
    f.receipt.terms_hash = f.order.terms_hash;
    let literal_accepted = AcceptedReceipt {
        terminal: 1,
        filled_quantity: 20_000_000,
        receipt_hash: hex("beb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888"),
    };
    check(&f, Ok(FilledDecision::Apply(literal_accepted)));
    f.order.state = OrderState::CancelRequested;
    f.order.cancellation_requested = true;
    check(&f, Ok(FilledDecision::Apply(literal_accepted)));
    f.order.state = OrderState::Settled;
    f.order.accepted_receipt = Some(literal_accepted);
    for flag in [false, true] {
        f.order.cancellation_requested = flag;
        check(&f, Ok(FilledDecision::Replay));
    }
}
