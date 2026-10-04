use anchor_lang::{
    prelude::{Pubkey, Space},
    AccountDeserialize, AccountSerialize, Discriminator,
};
use settlement_lab::{
    accounting::{Accounting, AccountingError},
    order_state::ValidationError,
};

// Independent Borsh field widths, excluding the account discriminator.
const ACCOUNTING_BYTES: usize = 32 + 4 * 16 + 1;
const MAX_ORDER_CASH: u64 = 9_223_372_036_854_775_807;

// Host arithmetic/storage fixtures only; no PDA, signer, or token flow is tested.
fn fixture() -> Accounting {
    Accounting {
        config: Pubkey::new_from_array([0xa1; 32]),
        total_deposited: 100,
        total_refunded: 20,
        total_reimbursed: 30,
        total_shares_minted: 60,
        bump: 254,
    }
}

fn bytes(account: &Accounting) -> Vec<u8> {
    let mut serialized = Vec::new();
    account.try_serialize(&mut serialized).unwrap();
    serialized
}

fn rejects_unchanged(mut account: Accounting, cash: u64, expected: AccountingError) {
    let before = bytes(&account);
    assert_eq!(account.record_deposit(cash), Err(expected));
    assert_eq!(bytes(&account), before);
}

#[test]
fn init_space_and_allocation_match_independent_widths() {
    assert_eq!(ACCOUNTING_BYTES, 97);
    assert_eq!(Accounting::INIT_SPACE, ACCOUNTING_BYTES);
    assert_eq!(Accounting::DISCRIMINATOR.len(), 8);
    assert_eq!(
        Accounting::DISCRIMINATOR.len() + Accounting::INIT_SPACE,
        105
    );
    assert_eq!(bytes(&fixture()).len(), 105);
}

#[test]
fn complete_account_round_trip_matches_literal_little_endian_bytes() {
    // Deliberately arbitrary storage values, not a valid cash-accounting record.
    let account = Accounting {
        config: Pubkey::new_from_array([0xa1; 32]),
        total_deposited: 0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10,
        total_refunded: 0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00,
        total_reimbursed: 0xffee_ddcc_bbaa_9988_7766_5544_3322_1100,
        total_shares_minted: u128::MAX,
        bump: 254,
    };
    // Literal discriminator and payload expectations do not call a production
    // encoder. Borsh integers are little-endian, unlike protocol hash preimages.
    let mut expected = vec![1, 249, 15, 214, 81, 88, 40, 108];
    expected.extend_from_slice(&[0xa1; 32]);
    expected.extend_from_slice(&[
        0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02,
        0x01,
    ]);
    expected.extend_from_slice(&[
        0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
        0x11,
    ]);
    expected.extend_from_slice(&[
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
    ]);
    expected.extend_from_slice(&[0xff; 16]);
    expected.push(254);
    assert_eq!(expected.len(), 105);
    let serialized = bytes(&account);
    assert_eq!(serialized, expected);
    assert_eq!(
        Accounting::try_deserialize(&mut serialized.as_slice()).unwrap(),
        account
    );
}

#[test]
fn zero_counters_have_zero_outstanding_cash() {
    let account = Accounting {
        total_deposited: 0,
        total_refunded: 0,
        total_reimbursed: 0,
        total_shares_minted: 0,
        ..fixture()
    };
    assert_eq!(account.outstanding_cash(), Ok(0));
}

#[test]
fn outstanding_cash_subtracts_both_payout_categories() {
    assert_eq!(fixture().outstanding_cash(), Ok(50));
    let account = Accounting {
        total_deposited: 50,
        ..fixture()
    };
    assert_eq!(account.outstanding_cash(), Ok(0));
}

#[test]
fn successful_deposit_changes_only_total_deposited() {
    let mut account = fixture();
    let expected = Accounting {
        total_deposited: 107,
        ..fixture()
    };
    assert_eq!(account.record_deposit(7), Ok(()));
    assert_eq!(account, expected);
    assert_eq!(bytes(&account), bytes(&expected));
    assert_eq!(account.outstanding_cash(), Ok(57));
}

#[test]
fn zero_and_oversized_deposits_reject_without_mutation() {
    rejects_unchanged(
        fixture(),
        0,
        AccountingError::InvalidAmount(ValidationError::ZeroCash),
    );
    for cash in [MAX_ORDER_CASH + 1, u64::MAX] {
        rejects_unchanged(
            fixture(),
            cash,
            AccountingError::InvalidAmount(ValidationError::CashTooLarge),
        );
    }
}

#[test]
fn smallest_and_largest_valid_per_order_deposits_are_accepted() {
    for (cash, expected_total) in [(1, 101), (MAX_ORDER_CASH, 9_223_372_036_854_775_907)] {
        let mut account = fixture();
        assert_eq!(account.record_deposit(cash), Ok(()));
        let expected = Accounting {
            total_deposited: expected_total,
            ..fixture()
        };
        assert_eq!(bytes(&account), bytes(&expected));
    }
}

#[test]
fn cumulative_deposits_cross_u64_without_losing_precision() {
    let mut account = Accounting {
        total_deposited: 0,
        total_refunded: 0,
        total_reimbursed: 0,
        total_shares_minted: 0,
        ..fixture()
    };
    for expected in [
        9_223_372_036_854_775_807,
        18_446_744_073_709_551_614,
        27_670_116_110_564_327_421,
    ] {
        assert_eq!(account.record_deposit(MAX_ORDER_CASH), Ok(()));
        assert_eq!(account.total_deposited, expected);
        assert_eq!(account.outstanding_cash(), Ok(expected));
    }
    assert!(account.total_deposited > u128::from(u64::MAX));
    let serialized = bytes(&account);
    assert_eq!(
        Accounting::try_deserialize(&mut serialized.as_slice()).unwrap(),
        account
    );
}

#[test]
fn outstanding_cash_preserves_u128_payout_precision() {
    let account = Accounting {
        total_deposited: 55_340_232_221_128_654_858,
        total_refunded: 18_446_744_073_709_551_616,
        total_reimbursed: 18_446_744_073_709_551_617,
        ..fixture()
    };
    assert_eq!(account.outstanding_cash(), Ok(18_446_744_073_709_551_625));
}

#[test]
fn exact_u128_addition_boundary_succeeds_then_overflow_is_immutable() {
    // Artificial arithmetic limits, not executed token flows or validator tests.
    for cash in [1, MAX_ORDER_CASH] {
        let mut account = Accounting {
            total_deposited: u128::MAX - u128::from(cash),
            total_shares_minted: u128::MAX,
            ..fixture()
        };
        let expected = Accounting {
            total_deposited: u128::MAX,
            ..account.clone()
        };
        assert_eq!(account.record_deposit(cash), Ok(()));
        assert_eq!(bytes(&account), bytes(&expected));
        assert_eq!(account.outstanding_cash(), Ok(u128::MAX - 50));
        rejects_unchanged(account, 1, AccountingError::ArithmeticOverflow);
        // The same valid cash amount exceeds capacity by exactly one unit.
        rejects_unchanged(
            Accounting {
                total_deposited: u128::MAX - u128::from(cash) + 1,
                ..fixture()
            },
            cash,
            AccountingError::ArithmeticOverflow,
        );
    }
}

#[test]
fn payout_sum_accepts_exact_u128_limit_and_rejects_overflow() {
    let mut account = Accounting {
        total_deposited: u128::MAX,
        total_refunded: u128::MAX - 1,
        total_reimbursed: 1,
        ..fixture()
    };
    assert_eq!(account.outstanding_cash(), Ok(0));
    account.total_reimbursed = 2;
    assert_eq!(
        account.outstanding_cash(),
        Err(AccountingError::ArithmeticOverflow)
    );
}

#[test]
fn payouts_exceeding_deposits_are_distinct_from_overflow() {
    for (refunded, reimbursed) in [(101, 0), (0, 101), (51, 50)] {
        let account = Accounting {
            total_refunded: refunded,
            total_reimbursed: reimbursed,
            ..fixture()
        };
        assert_eq!(
            account.outstanding_cash(),
            Err(AccountingError::PayoutsExceedDeposits)
        );
    }
}

#[test]
fn deposits_cannot_silently_repair_invalid_existing_accounting() {
    // Adding one would cover the deficit; it must still reject the original state.
    rejects_unchanged(
        Accounting {
            total_deposited: 49,
            ..fixture()
        },
        1,
        AccountingError::PayoutsExceedDeposits,
    );
    rejects_unchanged(
        Accounting {
            total_deposited: 0,
            total_refunded: u128::MAX,
            total_reimbursed: 1,
            ..fixture()
        },
        MAX_ORDER_CASH,
        AccountingError::ArithmeticOverflow,
    );
}

#[test]
fn outstanding_cash_never_mutates_successful_or_invalid_records() {
    for (account, expected) in [
        (fixture(), Ok(50)),
        (
            Accounting {
                total_deposited: 49,
                ..fixture()
            },
            Err(AccountingError::PayoutsExceedDeposits),
        ),
        (
            Accounting {
                total_deposited: u128::MAX,
                total_refunded: u128::MAX,
                total_reimbursed: 1,
                ..fixture()
            },
            Err(AccountingError::ArithmeticOverflow),
        ),
    ] {
        let before = bytes(&account);
        assert_eq!(account.outstanding_cash(), expected);
        assert_eq!(bytes(&account), before);
    }
}
