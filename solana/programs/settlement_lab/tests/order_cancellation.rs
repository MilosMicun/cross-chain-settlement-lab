use anchor_lang::{prelude::Pubkey, AccountSerialize};
use settlement_lab::{
    order_cancellation::{apply_cancellation_request, CancellationTransitionError},
    order_state::{AcceptedReceipt, Order, OrderState},
    protocol_encoding::{receipt_hash, Receipt},
};

// Host fixtures only: no terminal on-chain execution or authorization is claimed.
fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
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

fn bytes(order: &Order) -> Vec<u8> {
    let mut bytes = Vec::new();
    order.try_serialize(&mut bytes).unwrap();
    bytes
}
fn terminal(state: OrderState, requested: bool) -> Order {
    let mut order = order_fixture();
    order.state = state;
    order.cancellation_requested = requested;
    let receipt = Receipt {
        terms_hash: order.terms_hash,
        terminal: if state == OrderState::Settled { 1 } else { 2 },
        filled_quantity: if state == OrderState::Settled {
            20_000_000
        } else {
            0
        },
    };
    order.accepted_receipt = Some(AcceptedReceipt {
        terminal: receipt.terminal,
        filled_quantity: receipt.filled_quantity,
        receipt_hash: receipt_hash(&receipt).unwrap(),
    });
    order
}
fn rejects_unchanged(mut order: Order, expected: CancellationTransitionError) {
    let before = bytes(&order);
    assert_eq!(apply_cancellation_request(&mut order), Err(expected));
    assert_eq!(bytes(&order), before);
}
#[test]
fn pending_changes_only_state_and_flag() {
    let mut order = order_fixture();
    let mut expected = order_fixture();
    expected.state = OrderState::CancelRequested;
    expected.cancellation_requested = true;
    assert_eq!(apply_cancellation_request(&mut order), Ok(true));
    assert_eq!(order, expected);
    assert_eq!(bytes(&order), bytes(&expected));
}
#[test]
fn duplicate_request_preserves_complete_record() {
    let mut order = order_fixture();
    assert_eq!(apply_cancellation_request(&mut order), Ok(true));
    let before = bytes(&order);
    assert_eq!(apply_cancellation_request(&mut order), Ok(false));
    assert_eq!(bytes(&order), before);
}
#[test]
fn settled_prior_request_preserves_realistic_receipt() {
    let mut order = terminal(OrderState::Settled, true);
    let before = bytes(&order);
    assert_eq!(apply_cancellation_request(&mut order), Ok(false));
    assert_eq!(bytes(&order), before);
}
#[test]
fn refunded_prior_request_preserves_realistic_receipt() {
    let mut order = terminal(OrderState::Refunded, true);
    let before = bytes(&order);
    assert_eq!(apply_cancellation_request(&mut order), Ok(false));
    assert_eq!(bytes(&order), before);
}
#[test]
fn terminal_without_prior_request_rejects_without_mutation() {
    rejects_unchanged(
        terminal(OrderState::Settled, false),
        CancellationTransitionError::TerminalWithoutRequest,
    );
    // Refunded without a prior user request is already inconsistent.
    rejects_unchanged(
        terminal(OrderState::Refunded, false),
        CancellationTransitionError::InconsistentRecord,
    );
}
#[test]
fn inconsistent_state_flag_receipt_combinations_reject_without_mutation() {
    use CancellationTransitionError::InconsistentRecord;
    let receipt = terminal(OrderState::Settled, true).accepted_receipt;
    for state in [OrderState::Pending, OrderState::CancelRequested] {
        for flag in [false, true] {
            for accepted in [None, receipt] {
                if accepted.is_none() && flag == (state == OrderState::CancelRequested) {
                    continue;
                }
                let mut order = order_fixture();
                order.state = state;
                order.cancellation_requested = flag;
                order.accepted_receipt = accepted;
                rejects_unchanged(order, InconsistentRecord);
            }
        }
    }
    for state in [OrderState::Settled, OrderState::Refunded] {
        let mut order = terminal(state, true);
        order.accepted_receipt = None;
        rejects_unchanged(order, InconsistentRecord);
        let mut order = terminal(state, true);
        order.accepted_receipt.as_mut().unwrap().terminal = 3;
        rejects_unchanged(order, InconsistentRecord);
        let mut order = terminal(state, true);
        let accepted = order.accepted_receipt.as_mut().unwrap();
        accepted.filled_quantity += 1;
        accepted.receipt_hash = receipt_hash(&Receipt {
            terms_hash: order.terms_hash,
            terminal: accepted.terminal,
            filled_quantity: accepted.filled_quantity,
        })
        .unwrap();
        rejects_unchanged(order, InconsistentRecord);
        // A correctly hashed receipt for the opposite terminal state also fails.
        let mut order = terminal(state, true);
        order.accepted_receipt = terminal(
            if state == OrderState::Settled {
                OrderState::Refunded
            } else {
                OrderState::Settled
            },
            true,
        )
        .accepted_receipt;
        rejects_unchanged(order, InconsistentRecord);
        let mut order = terminal(state, true);
        order.accepted_receipt.as_mut().unwrap().receipt_hash[0] ^= 1;
        rejects_unchanged(order, InconsistentRecord);
    }
    let mut order = terminal(OrderState::Settled, true);
    order.minimum_shares = 20_000_001;
    rejects_unchanged(order, InconsistentRecord);
}
