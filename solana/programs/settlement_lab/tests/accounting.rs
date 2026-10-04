use anchor_lang::{
    prelude::{Pubkey, Space},
    AccountDeserialize, AccountSerialize, Discriminator,
};
use settlement_lab::{
    accounting::{Accounting, AccountingError, FillAccountingError},
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

fn fill_rejects_unchanged(
    mut account: Accounting,
    cash: u64,
    quantity: u64,
    expected: FillAccountingError,
) {
    let before = bytes(&account);
    assert_eq!(account.record_fill(cash, quantity), Err(expected));
    assert_eq!(bytes(&account), before);
}

fn fill_succeeds_as(account: &mut Accounting, cash: u64, quantity: u64, expected: Accounting) {
    assert_eq!(account.record_fill(cash, quantity), Ok(()));
    assert_eq!(*account, expected);
    assert_eq!(bytes(account), bytes(&expected));
}

#[test]
fn successful_fill_changes_only_reimbursement_and_issuance() {
    let mut account = fixture();
    fill_succeeds_as(
        &mut account,
        7,
        14,
        Accounting {
            total_reimbursed: 37,
            total_shares_minted: 74,
            ..fixture()
        },
    );
    assert_eq!(account.outstanding_cash(), Ok(43));
}

#[test]
fn smallest_fill_uses_exact_integer_base_units() {
    fill_succeeds_as(
        &mut fixture(),
        1,
        2,
        Accounting {
            total_reimbursed: 31,
            total_shares_minted: 62,
            ..fixture()
        },
    );
}

// Large u128 starting counters below are artificial host arithmetic fixtures,
// not demonstrated token flows or validator scenarios. They impose no global
// shares-to-reimbursement relationship beyond the new fill's exact quantity.
#[test]
fn largest_valid_fill_has_exact_output() {
    let mut account = Accounting {
        total_deposited: 9_223_372_036_854_775_857,
        ..fixture()
    };
    let expected = Accounting {
        total_deposited: 9_223_372_036_854_775_857,
        total_reimbursed: 9_223_372_036_854_775_837,
        total_shares_minted: 18_446_744_073_709_551_674,
        ..fixture()
    };
    fill_succeeds_as(
        &mut account,
        MAX_ORDER_CASH,
        18_446_744_073_709_551_614,
        expected,
    );
    assert_eq!(account.outstanding_cash(), Ok(0));
}

#[test]
fn zero_and_oversized_fill_cash_reject_unchanged() {
    fill_rejects_unchanged(
        fixture(),
        0,
        0,
        FillAccountingError::Accounting(AccountingError::InvalidAmount(ValidationError::ZeroCash)),
    );
    for cash in [MAX_ORDER_CASH + 1, u64::MAX] {
        fill_rejects_unchanged(
            fixture(),
            cash,
            u64::MAX,
            FillAccountingError::Accounting(AccountingError::InvalidAmount(
                ValidationError::CashTooLarge,
            )),
        );
    }
}

#[test]
fn incorrect_fill_quantities_reject_unchanged() {
    for (cash, expected, quantities) in [
        (7, 14, [0, 13, 15, u64::MAX]),
        (
            MAX_ORDER_CASH,
            18_446_744_073_709_551_614,
            [0, 1, 18_446_744_073_709_551_613, u64::MAX],
        ),
    ] {
        for actual in quantities {
            fill_rejects_unchanged(
                Accounting {
                    total_deposited: u128::MAX,
                    ..fixture()
                },
                cash,
                actual,
                FillAccountingError::InvalidFilledQuantity { expected, actual },
            );
        }
    }
}

#[test]
fn fill_exactly_exhausts_outstanding_cash() {
    let mut account = fixture();
    fill_succeeds_as(
        &mut account,
        50,
        100,
        Accounting {
            total_reimbursed: 80,
            total_shares_minted: 160,
            ..fixture()
        },
    );
    assert_eq!(account.outstanding_cash(), Ok(0));
}

#[test]
fn fill_payout_exceeding_deposits_by_one_rejects_before_shares_overflow() {
    fill_rejects_unchanged(
        Accounting {
            total_shares_minted: u128::MAX,
            ..fixture()
        },
        51,
        102,
        FillAccountingError::Accounting(AccountingError::PayoutsExceedDeposits),
    );
}

#[test]
fn fill_payout_limit_includes_existing_refunds_and_reimbursements() {
    for (refunded, reimbursed) in [(50, 0), (0, 50), (20, 30)] {
        fill_rejects_unchanged(
            Accounting {
                total_refunded: refunded,
                total_reimbursed: reimbursed,
                ..fixture()
            },
            51,
            102,
            FillAccountingError::Accounting(AccountingError::PayoutsExceedDeposits),
        );
    }
}

#[test]
fn fill_rejects_existing_payout_sum_overflow_unchanged() {
    fill_rejects_unchanged(
        Accounting {
            total_deposited: u128::MAX,
            total_refunded: u128::MAX,
            total_reimbursed: 1,
            ..fixture()
        },
        1,
        2,
        FillAccountingError::Accounting(AccountingError::ArithmeticOverflow),
    );
}

#[test]
fn fill_rejects_existing_payouts_exceeding_deposits_unchanged() {
    for (refunded, reimbursed) in [(101, 0), (0, 101), (51, 50)] {
        fill_rejects_unchanged(
            Accounting {
                total_refunded: refunded,
                total_reimbursed: reimbursed,
                total_shares_minted: u128::MAX,
                ..fixture()
            },
            1,
            2,
            FillAccountingError::Accounting(AccountingError::PayoutsExceedDeposits),
        );
    }
}

#[test]
fn fill_candidate_reimbursement_overflow_preserves_record() {
    fill_rejects_unchanged(
        Accounting {
            total_deposited: u128::MAX,
            total_refunded: 0,
            total_reimbursed: u128::MAX,
            ..fixture()
        },
        1,
        2,
        FillAccountingError::Accounting(AccountingError::ArithmeticOverflow),
    );
}

#[test]
fn fill_candidate_combined_payout_overflows_with_reimbursement_capacity() {
    fill_rejects_unchanged(
        Accounting {
            total_deposited: u128::MAX,
            total_refunded: u128::MAX - 31,
            total_reimbursed: 30,
            ..fixture()
        },
        2,
        4,
        FillAccountingError::Accounting(AccountingError::ArithmeticOverflow),
    );
}

#[test]
fn fill_shares_overflow_preserves_both_counters_after_valid_cash_checks() {
    fill_rejects_unchanged(
        Accounting {
            total_shares_minted: u128::MAX - 13,
            ..fixture()
        },
        7,
        14,
        FillAccountingError::Accounting(AccountingError::ArithmeticOverflow),
    );
}

#[test]
fn fill_accepts_exact_u128_counter_and_payout_boundaries() {
    for (cash, quantity) in [(1, 2), (MAX_ORDER_CASH, 18_446_744_073_709_551_614)] {
        for refunded in [0, 1] {
            let mut account = Accounting {
                total_deposited: u128::MAX,
                total_refunded: refunded,
                total_reimbursed: u128::MAX - refunded - u128::from(cash),
                total_shares_minted: u128::MAX - u128::from(quantity),
                ..fixture()
            };
            let expected = Accounting {
                total_deposited: u128::MAX,
                total_refunded: refunded,
                total_reimbursed: u128::MAX - refunded,
                total_shares_minted: u128::MAX,
                ..fixture()
            };
            fill_succeeds_as(&mut account, cash, quantity, expected);
            assert_eq!(account.outstanding_cash(), Ok(0));
        }
    }
}

#[test]
fn cumulative_fills_cross_u64_boundaries_without_losing_precision() {
    let mut account = Accounting {
        total_deposited: 27_670_116_110_564_327_421,
        total_refunded: 0,
        total_reimbursed: 0,
        total_shares_minted: 0,
        ..fixture()
    };
    for (reimbursed, shares, outstanding) in [
        (
            9_223_372_036_854_775_807,
            18_446_744_073_709_551_614,
            18_446_744_073_709_551_614,
        ),
        (
            18_446_744_073_709_551_614,
            36_893_488_147_419_103_228,
            9_223_372_036_854_775_807,
        ),
        (27_670_116_110_564_327_421, 55_340_232_221_128_654_842, 0),
    ] {
        let expected = Accounting {
            total_deposited: 27_670_116_110_564_327_421,
            total_refunded: 0,
            total_reimbursed: reimbursed,
            total_shares_minted: shares,
            ..fixture()
        };
        fill_succeeds_as(
            &mut account,
            MAX_ORDER_CASH,
            18_446_744_073_709_551_614,
            expected,
        );
        assert_eq!(account.outstanding_cash(), Ok(outstanding));
    }
    assert!(account.total_reimbursed > u128::from(u64::MAX));
    assert!(account.total_shares_minted > u128::from(u64::MAX));
    let serialized = bytes(&account);
    assert_eq!(
        Accounting::try_deserialize(&mut serialized.as_slice()).unwrap(),
        account
    );
}

#[test]
fn fill_validates_cash_then_quantity_before_existing_accounting() {
    let account = Accounting {
        total_deposited: 0,
        total_refunded: u128::MAX,
        total_reimbursed: 1,
        total_shares_minted: u128::MAX,
        ..fixture()
    };
    for (cash, quantity, error) in [
        (
            0,
            0,
            FillAccountingError::Accounting(AccountingError::InvalidAmount(
                ValidationError::ZeroCash,
            )),
        ),
        (
            u64::MAX,
            0,
            FillAccountingError::Accounting(AccountingError::InvalidAmount(
                ValidationError::CashTooLarge,
            )),
        ),
        (
            1,
            0,
            FillAccountingError::InvalidFilledQuantity {
                expected: 2,
                actual: 0,
            },
        ),
        (
            1,
            2,
            FillAccountingError::Accounting(AccountingError::ArithmeticOverflow),
        ),
    ] {
        fill_rejects_unchanged(account.clone(), cash, quantity, error);
    }
}

fn refund_rejects_unchanged(mut account: Accounting, cash: u64, expected: AccountingError) {
    let before = bytes(&account);
    assert_eq!(account.record_refund(cash), Err(expected));
    assert_eq!(bytes(&account), before);
}

fn refund_succeeds_as(account: &mut Accounting, cash: u64, expected: Accounting) {
    assert_eq!(account.record_refund(cash), Ok(()));
    assert_eq!(*account, expected);
    assert_eq!(bytes(account), bytes(&expected));
}

#[test]
fn successful_refund_changes_only_total_refunded() {
    let mut account = fixture();
    refund_succeeds_as(
        &mut account,
        7,
        Accounting {
            total_refunded: 27,
            ..fixture()
        },
    );
    assert_eq!(account.outstanding_cash(), Ok(43));
}

#[test]
fn smallest_and_largest_valid_per_order_refunds_are_accepted() {
    for (cash, refunded, outstanding) in [
        (1, 21, 9_223_372_036_854_775_806),
        (MAX_ORDER_CASH, 9_223_372_036_854_775_827, 0),
    ] {
        let mut account = Accounting {
            total_deposited: 9_223_372_036_854_775_857,
            ..fixture()
        };
        refund_succeeds_as(
            &mut account,
            cash,
            Accounting {
                total_deposited: 9_223_372_036_854_775_857,
                total_refunded: refunded,
                ..fixture()
            },
        );
        assert_eq!(account.outstanding_cash(), Ok(outstanding));
    }
}

#[test]
fn refund_exactly_exhausts_outstanding_cash() {
    let mut account = fixture();
    refund_succeeds_as(
        &mut account,
        50,
        Accounting {
            total_refunded: 70,
            ..fixture()
        },
    );
    assert_eq!(account.outstanding_cash(), Ok(0));
    refund_rejects_unchanged(account, 1, AccountingError::PayoutsExceedDeposits);
}

#[test]
fn refund_payout_limit_includes_existing_refunds_and_reimbursements() {
    // Each record has 50 remaining; 51 must fail, including when the refund
    // counter alone would remain below deposits.
    for (refunded, reimbursed) in [(50, 0), (0, 50), (20, 30)] {
        refund_rejects_unchanged(
            Accounting {
                total_refunded: refunded,
                total_reimbursed: reimbursed,
                ..fixture()
            },
            51,
            AccountingError::PayoutsExceedDeposits,
        );
    }
}

#[test]
fn zero_and_oversized_refund_cash_reject_unchanged() {
    refund_rejects_unchanged(
        fixture(),
        0,
        AccountingError::InvalidAmount(ValidationError::ZeroCash),
    );
    for cash in [MAX_ORDER_CASH + 1, u64::MAX] {
        refund_rejects_unchanged(
            fixture(),
            cash,
            AccountingError::InvalidAmount(ValidationError::CashTooLarge),
        );
    }
}

// Extreme u128 counters are synthetic host arithmetic fixtures. They do not
// demonstrate economically reachable token flows or an on-chain refund.
#[test]
fn refund_rejects_existing_payout_sum_overflow_unchanged() {
    refund_rejects_unchanged(
        Accounting {
            total_deposited: u128::MAX,
            total_refunded: u128::MAX - 1,
            total_reimbursed: 2,
            ..fixture()
        },
        1,
        AccountingError::ArithmeticOverflow,
    );
}

#[test]
fn refund_rejects_existing_payouts_exceeding_deposits_unchanged() {
    for (refunded, reimbursed) in [(101, 0), (0, 101), (51, 50)] {
        refund_rejects_unchanged(
            Accounting {
                total_refunded: refunded,
                total_reimbursed: reimbursed,
                ..fixture()
            },
            1,
            AccountingError::PayoutsExceedDeposits,
        );
    }
}

#[test]
fn refund_candidate_total_refunded_overflow_preserves_record() {
    refund_rejects_unchanged(
        Accounting {
            total_deposited: u128::MAX,
            total_refunded: u128::MAX,
            total_reimbursed: 0,
            ..fixture()
        },
        1,
        AccountingError::ArithmeticOverflow,
    );
}

#[test]
fn refund_candidate_combined_payout_overflows_with_refund_capacity() {
    refund_rejects_unchanged(
        Accounting {
            total_deposited: u128::MAX,
            total_refunded: u128::MAX - 31,
            total_reimbursed: 30,
            ..fixture()
        },
        2,
        AccountingError::ArithmeticOverflow,
    );
}

#[test]
fn refund_exact_u128_boundary_succeeds_then_overflow_is_immutable() {
    for cash in [1, MAX_ORDER_CASH] {
        for reimbursed in [0, 1] {
            let mut account = Accounting {
                total_deposited: u128::MAX,
                total_refunded: u128::MAX - reimbursed - u128::from(cash),
                total_reimbursed: reimbursed,
                ..fixture()
            };
            refund_succeeds_as(
                &mut account,
                cash,
                Accounting {
                    total_deposited: u128::MAX,
                    total_refunded: u128::MAX - reimbursed,
                    total_reimbursed: reimbursed,
                    ..fixture()
                },
            );
            assert_eq!(account.outstanding_cash(), Ok(0));
            refund_rejects_unchanged(account, 1, AccountingError::ArithmeticOverflow);
        }
    }
}

#[test]
fn cumulative_refunds_cross_u64_without_losing_precision() {
    let mut account = Accounting {
        total_deposited: 27_670_116_110_564_327_451,
        total_refunded: 0,
        ..fixture()
    };
    for (refunded, outstanding) in [
        (9_223_372_036_854_775_807, 18_446_744_073_709_551_614),
        (18_446_744_073_709_551_614, 9_223_372_036_854_775_807),
        (27_670_116_110_564_327_421, 0),
    ] {
        refund_succeeds_as(
            &mut account,
            MAX_ORDER_CASH,
            Accounting {
                total_deposited: 27_670_116_110_564_327_451,
                total_refunded: refunded,
                ..fixture()
            },
        );
        assert_eq!(account.outstanding_cash(), Ok(outstanding));
    }
    assert!(account.total_refunded > u128::from(u64::MAX));
    let serialized = bytes(&account);
    assert_eq!(
        Accounting::try_deserialize(&mut serialized.as_slice()).unwrap(),
        account
    );
}

#[test]
fn refund_preserves_maximum_cumulative_issuance() {
    let mut account = Accounting {
        total_shares_minted: u128::MAX,
        ..fixture()
    };
    refund_succeeds_as(
        &mut account,
        7,
        Accounting {
            total_refunded: 27,
            total_shares_minted: u128::MAX,
            ..fixture()
        },
    );
    assert_eq!(account.outstanding_cash(), Ok(43));
}

#[test]
fn refund_validates_cash_before_existing_accounting_and_candidate_payouts() {
    for (account, existing_error) in [
        (
            Accounting {
                total_deposited: 0,
                total_refunded: u128::MAX,
                total_reimbursed: 1,
                ..fixture()
            },
            AccountingError::ArithmeticOverflow,
        ),
        (
            Accounting {
                total_deposited: 0,
                total_refunded: u128::MAX,
                total_reimbursed: 0,
                ..fixture()
            },
            AccountingError::PayoutsExceedDeposits,
        ),
    ] {
        for (cash, error) in [
            (0, AccountingError::InvalidAmount(ValidationError::ZeroCash)),
            (
                u64::MAX,
                AccountingError::InvalidAmount(ValidationError::CashTooLarge),
            ),
            (1, existing_error),
        ] {
            // The second record would also overflow the candidate refund.
            // Existing accounting must win once cash validation succeeds.
            refund_rejects_unchanged(account.clone(), cash, error);
        }
    }
}

#[test]
fn mixed_deposits_fills_and_refunds_match_independent_intermediate_counters() {
    enum Operation {
        Deposit(u64),
        Fill(u64, u64),
        Refund(u64),
    }
    use Operation::*;

    let mut account = Accounting {
        total_deposited: 0,
        total_refunded: 0,
        total_reimbursed: 0,
        total_shares_minted: 0,
        ..fixture()
    };
    // Four full orders: fill 6 and 9 mock USD; refund 4 and 2 mock USD,
    // then a fifth order refunds 3. Literal expectations use six decimals.
    for (operation, counters, outstanding) in [
        (Deposit(6_000_000), [6_000_000, 0, 0, 0], 6_000_000),
        (Deposit(4_000_000), [10_000_000, 0, 0, 0], 10_000_000),
        (
            Fill(6_000_000, 12_000_000),
            [10_000_000, 0, 6_000_000, 12_000_000],
            4_000_000,
        ),
        (
            Refund(4_000_000),
            [10_000_000, 4_000_000, 6_000_000, 12_000_000],
            0,
        ),
        (
            Deposit(9_000_000),
            [19_000_000, 4_000_000, 6_000_000, 12_000_000],
            9_000_000,
        ),
        (
            Deposit(2_000_000),
            [21_000_000, 4_000_000, 6_000_000, 12_000_000],
            11_000_000,
        ),
        (
            Refund(2_000_000),
            [21_000_000, 6_000_000, 6_000_000, 12_000_000],
            9_000_000,
        ),
        (
            Deposit(3_000_000),
            [24_000_000, 6_000_000, 6_000_000, 12_000_000],
            12_000_000,
        ),
        (
            Fill(9_000_000, 18_000_000),
            [24_000_000, 6_000_000, 15_000_000, 30_000_000],
            3_000_000,
        ),
        (
            Refund(3_000_000),
            [24_000_000, 9_000_000, 15_000_000, 30_000_000],
            0,
        ),
    ] {
        match operation {
            Deposit(cash) => assert_eq!(account.record_deposit(cash), Ok(())),
            Fill(cash, quantity) => assert_eq!(account.record_fill(cash, quantity), Ok(())),
            Refund(cash) => assert_eq!(account.record_refund(cash), Ok(())),
        }
        let [total_deposited, total_refunded, total_reimbursed, total_shares_minted] = counters;
        let expected = Accounting {
            total_deposited,
            total_refunded,
            total_reimbursed,
            total_shares_minted,
            ..fixture()
        };
        assert_eq!(account, expected);
        assert_eq!(bytes(&account), bytes(&expected));
        assert_eq!(account.outstanding_cash(), Ok(outstanding));
    }
}
