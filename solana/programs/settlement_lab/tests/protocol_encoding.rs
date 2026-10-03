use settlement_lab::protocol_encoding::{
    identity_bytes, order_id, receipt_bytes, receipt_hash, terms_bytes, terms_hash, Domain,
    EncodingError, Identity, Receipt, Terms,
};

const GOLDEN_ORDER_ID: &str = "bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7";
const GOLDEN_TERMS_HASH: &str = "081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8";
const GOLDEN_FILLED_HASH: &str = "beb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888";
const GOLDEN_CANCELLED_HASH: &str =
    "acc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b";

// Literal fixtures follow SPEC.md field boundaries; no encoder builds expectations.
const GOLDEN_IDENTITY_BYTES: &str = concat!(
    "4343534c49443031",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222222222222222222222222222",
    "3333333333333333333333333333333333333333333333333333333333333333",
    "0000000000000000000000000000000000000000000000000000000000007a69",
    "4444444444444444444444444444444444444444",
    "5555555555555555555555555555555555555555555555555555555555555555",
    "0000000000000007",
);
const GOLDEN_TERMS_BYTES: &str = concat!(
    "4343534c54523031",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222222222222222222222222222",
    "3333333333333333333333333333333333333333333333333333333333333333",
    "0000000000000000000000000000000000000000000000000000000000007a69",
    "4444444444444444444444444444444444444444",
    "bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7",
    "5555555555555555555555555555555555555555555555555555555555555555",
    "0000000000000007",
    "6666666666666666666666666666666666666666666666666666666666666666",
    "00",
    "0000000000989680",
    "0000000001312d00",
);
const GOLDEN_FILLED_BYTES: &str = concat!(
    "4343534c52433031",
    "081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8",
    "01",
    "0000000001312d00",
);
const GOLDEN_CANCELLED_BYTES: &str = concat!(
    "4343534c52433031",
    "081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8",
    "02",
    "0000000000000000",
);

fn hex<const N: usize>(literal: &str) -> [u8; N] {
    assert_eq!(literal.len(), N * 2, "incorrect fixture length");
    let mut bytes = [0; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&literal[2 * i..2 * i + 2], 16).expect("invalid hex fixture");
    }
    bytes
}

fn golden_terms() -> Terms {
    Terms {
        identity: Identity {
            domain: Domain {
                source_domain: [0x11; 32],
                destination_domain: [0x22; 32],
                solana_program: [0x33; 32],
                chain_id: hex("0000000000000000000000000000000000000000000000000000000000007a69"),
                settlement: [0x44; 20],
            },
            user: [0x55; 32],
            nonce: 7,
        },
        market: [0x66; 32],
        outcome: 0,
        cash_amount: 10_000_000,
        minimum_shares: 20_000_000,
    }
}

fn golden_receipt(terminal: u8) -> Receipt {
    Receipt {
        terms_hash: hex(GOLDEN_TERMS_HASH),
        terminal,
        filled_quantity: if terminal == 1 { 20_000_000 } else { 0 },
    }
}

#[test]
fn golden_identity_preimage_and_order_id() {
    let identity = golden_terms().identity;
    assert_eq!(identity_bytes(&identity), hex::<196>(GOLDEN_IDENTITY_BYTES));
    assert_eq!(order_id(&identity), hex::<32>(GOLDEN_ORDER_ID));
}

#[test]
fn golden_terms_preimage_and_hash() {
    let terms = golden_terms();
    assert_eq!(terms_bytes(&terms), hex::<277>(GOLDEN_TERMS_BYTES));
    assert_eq!(terms_hash(&terms), hex::<32>(GOLDEN_TERMS_HASH));
}

#[test]
fn golden_filled_receipt_preimage_and_hash() {
    let receipt = golden_receipt(1);
    assert_eq!(receipt_bytes(&receipt), Ok(hex::<49>(GOLDEN_FILLED_BYTES)));
    assert_eq!(receipt_hash(&receipt), Ok(hex::<32>(GOLDEN_FILLED_HASH)));
}

#[test]
fn golden_cancelled_receipt_preimage_and_hash() {
    let receipt = golden_receipt(2);
    assert_eq!(
        receipt_bytes(&receipt),
        Ok(hex::<49>(GOLDEN_CANCELLED_BYTES))
    );
    assert_eq!(receipt_hash(&receipt), Ok(hex::<32>(GOLDEN_CANCELLED_HASH)));
}

fn assert_domain_boundaries(bytes: &[u8], domain: &Domain) {
    assert_eq!(&bytes[8..40], &domain.source_domain);
    assert_eq!(&bytes[40..72], &domain.destination_domain);
    assert_eq!(&bytes[72..104], &domain.solana_program);
    assert_eq!(&bytes[104..136], &domain.chain_id);
    assert_eq!(&bytes[136..156], &domain.settlement);
    assert_eq!(bytes[8..156].len(), 148);
}

#[test]
fn exact_lengths_and_all_field_boundaries() {
    let terms = golden_terms();
    let identity = identity_bytes(&terms.identity);
    let encoded_terms = terms_bytes(&terms);
    assert_eq!(identity.len(), 196);
    assert_eq!(encoded_terms.len(), 277);
    assert_eq!(&identity[..8], b"CCSLID01");
    assert_eq!(&encoded_terms[..8], b"CCSLTR01");
    assert_domain_boundaries(&identity, &terms.identity.domain);
    assert_domain_boundaries(&encoded_terms, &terms.identity.domain);
    assert_eq!(&identity[156..188], &[0x55; 32]);
    assert_eq!(&identity[188..196], &hex::<8>("0000000000000007"));
    assert_eq!(&encoded_terms[156..188], &hex::<32>(GOLDEN_ORDER_ID));
    assert_eq!(&encoded_terms[188..220], &[0x55; 32]);
    assert_eq!(&encoded_terms[220..228], &hex::<8>("0000000000000007"));
    assert_eq!(&encoded_terms[228..260], &[0x66; 32]);
    assert_eq!(encoded_terms[260], 0);
    assert_eq!(&encoded_terms[261..269], &hex::<8>("0000000000989680"));
    assert_eq!(&encoded_terms[269..277], &hex::<8>("0000000001312d00"));

    for terminal in [1, 2] {
        let encoded = receipt_bytes(&golden_receipt(terminal)).unwrap();
        assert_eq!(encoded.len(), 49);
        assert_eq!(&encoded[..8], b"CCSLRC01");
        assert_eq!(&encoded[8..40], &hex::<32>(GOLDEN_TERMS_HASH));
        assert_eq!(encoded[40], terminal);
        let expected = if terminal == 1 {
            hex::<8>("0000000001312d00")
        } else {
            [0; 8]
        };
        assert_eq!(&encoded[41..49], &expected);
    }
}

#[test]
fn each_identity_field_binds_order_id_and_terms() {
    let original = golden_terms();
    let mut variants = [original; 7];
    variants[0].identity.domain.source_domain[0] ^= 1;
    variants[1].identity.domain.destination_domain[0] ^= 1;
    variants[2].identity.domain.solana_program[0] ^= 1;
    variants[3].identity.domain.chain_id[0] ^= 1;
    variants[4].identity.domain.settlement[0] ^= 1;
    variants[5].identity.user[0] ^= 1;
    variants[6].identity.nonce += 1;

    for (field, changed) in variants.iter().enumerate() {
        assert_ne!(
            identity_bytes(&changed.identity),
            identity_bytes(&original.identity),
            "field {field}"
        );
        assert_ne!(
            order_id(&changed.identity),
            order_id(&original.identity),
            "field {field}"
        );
        assert_ne!(
            terms_bytes(changed),
            terms_bytes(&original),
            "field {field}"
        );
        assert_ne!(terms_hash(changed), terms_hash(&original), "field {field}");
        assert_eq!(
            &terms_bytes(changed)[156..188],
            &order_id(&changed.identity)
        );
    }
}

#[test]
fn each_economic_field_changes_terms_but_preserves_identity() {
    let original = golden_terms();
    let mut variants = [original; 4];
    variants[0].market[0] ^= 1;
    variants[1].outcome = 1;
    variants[2].cash_amount += 1;
    variants[3].minimum_shares += 1;

    for (field, changed) in variants.iter().enumerate() {
        assert_eq!(
            identity_bytes(&changed.identity),
            identity_bytes(&original.identity),
            "field {field}"
        );
        assert_eq!(
            order_id(&changed.identity),
            order_id(&original.identity),
            "field {field}"
        );
        assert_ne!(
            terms_bytes(changed),
            terms_bytes(&original),
            "field {field}"
        );
        assert_ne!(terms_hash(changed), terms_hash(&original), "field {field}");
    }
}

#[test]
fn each_receipt_field_changes_encoding_and_hash() {
    let original = golden_receipt(1);
    let mut variants = [original; 3];
    variants[0].terms_hash[0] ^= 1;
    variants[1].terminal = 2;
    variants[2].filled_quantity += 1;

    for (field, changed) in variants.iter().enumerate() {
        assert_ne!(
            receipt_bytes(changed).unwrap(),
            receipt_bytes(&original).unwrap(),
            "field {field}"
        );
        assert_ne!(
            receipt_hash(changed).unwrap(),
            receipt_hash(&original).unwrap(),
            "field {field}"
        );
    }
}

#[test]
fn all_254_unsupported_terminals_retain_the_invalid_value() {
    let mut rejected = 0;
    for terminal in u8::MIN..=u8::MAX {
        if terminal == 1 || terminal == 2 {
            continue;
        }
        let receipt = Receipt {
            terminal,
            ..golden_receipt(1)
        };
        assert_eq!(
            receipt_bytes(&receipt),
            Err(EncodingError::InvalidTerminal(terminal))
        );
        assert_eq!(
            receipt_hash(&receipt),
            Err(EncodingError::InvalidTerminal(terminal))
        );
        rejected += 1;
    }
    assert_eq!(rejected, 254);
}

#[test]
fn asymmetric_integers_are_big_endian() {
    let mut terms = golden_terms();
    terms.identity.nonce = 0x0102_0304_0506_0708;
    terms.outcome = 0x9a;
    terms.cash_amount = 0x1122_3344_5566_7788;
    terms.minimum_shares = 0x8877_6655_4433_2211;
    let identity = identity_bytes(&terms.identity);
    let encoded_terms = terms_bytes(&terms);
    assert_eq!(&identity[188..196], &hex::<8>("0102030405060708"));
    assert_eq!(&encoded_terms[220..228], &hex::<8>("0102030405060708"));
    assert_eq!(encoded_terms[260], 0x9a);
    assert_eq!(&encoded_terms[261..269], &hex::<8>("1122334455667788"));
    assert_eq!(&encoded_terms[269..277], &hex::<8>("8877665544332211"));

    let receipt = Receipt {
        filled_quantity: 0xfedc_ba98_7654_3210,
        ..golden_receipt(1)
    };
    assert_eq!(
        &receipt_bytes(&receipt).unwrap()[41..49],
        &hex::<8>("fedcba9876543210")
    );
}

#[test]
fn chain_id_preserves_all_uint256_bytes() {
    let mut terms = golden_terms();
    let high_chain_id =
        hex::<32>("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
    terms.identity.domain.chain_id = high_chain_id;
    assert_eq!(&identity_bytes(&terms.identity)[104..136], &high_chain_id);
    assert_eq!(&terms_bytes(&terms)[104..136], &high_chain_id);

    let mut narrowed = terms;
    narrowed.identity.domain.chain_id[..24].fill(0);
    assert_ne!(order_id(&terms.identity), order_id(&narrowed.identity));
    assert_ne!(terms_hash(&terms), terms_hash(&narrowed));

    for chain_id in [[0; 32], [0xff; 32]] {
        terms.identity.domain.chain_id = chain_id;
        assert_eq!(&identity_bytes(&terms.identity)[104..136], &chain_id);
        assert_eq!(&terms_bytes(&terms)[104..136], &chain_id);
    }
}

#[test]
fn zero_and_maximum_u64_fields_are_not_truncated() {
    // These are type boundaries, not statements about valid orders.
    for (value, expected) in [(0, [0; 8]), (u64::MAX, [0xff; 8])] {
        let mut terms = golden_terms();
        terms.identity.nonce = value;
        terms.cash_amount = value;
        terms.minimum_shares = value;
        let identity = identity_bytes(&terms.identity);
        let encoded_terms = terms_bytes(&terms);
        assert_eq!(&identity[188..196], &expected);
        assert_eq!(&encoded_terms[220..228], &expected);
        assert_eq!(&encoded_terms[261..269], &expected);
        assert_eq!(&encoded_terms[269..277], &expected);
        assert_eq!(&encoded_terms[156..188], &order_id(&terms.identity));
        // Hashing must also succeed for the full range of encodable values.
        assert_ne!(terms_hash(&terms), hex::<32>(GOLDEN_TERMS_HASH));
    }
}

#[test]
fn both_terminal_tags_encode_quantities_without_economic_validation() {
    // Filled zero and Cancelled nonzero quantities are intentionally encodable.
    for terminal in [1, 2] {
        for (quantity, expected) in [
            (0, [0; 8]),
            (1, hex::<8>("0000000000000001")),
            (0xfedc_ba98_7654_3210, hex::<8>("fedcba9876543210")),
            (u64::MAX, [0xff; 8]),
        ] {
            let receipt = Receipt {
                terminal,
                filled_quantity: quantity,
                ..golden_receipt(1)
            };
            let encoded = receipt_bytes(&receipt).unwrap();
            assert_eq!(encoded[40], terminal);
            assert_eq!(&encoded[41..49], &expected);
            assert!(receipt_hash(&receipt).is_ok());
        }
    }
}
