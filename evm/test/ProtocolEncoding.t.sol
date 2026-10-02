// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolEncoding} from "../src/ProtocolEncoding.sol";

/// @dev Dependency-free tests. Golden preimages and hashes are copied from SPEC.md.
contract ProtocolEncodingTest {
    bytes32 private constant GOLDEN_ORDER_ID = 0xbd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7;
    bytes32 private constant GOLDEN_TERMS_HASH = 0x081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8;
    bytes32 private constant GOLDEN_FILLED_HASH = 0xbeb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888;
    bytes32 private constant GOLDEN_CANCELLED_HASH = 0xacc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b;

    function testGoldenOrderId() public pure {
        assert(ProtocolEncoding.orderId(goldenTerms().identity) == GOLDEN_ORDER_ID);
    }

    function testGoldenTermsPreimage() public pure {
        bytes memory expected = bytes.concat(
            hex"4343534c54523031",
            hex"1111111111111111111111111111111111111111111111111111111111111111",
            hex"2222222222222222222222222222222222222222222222222222222222222222",
            hex"3333333333333333333333333333333333333333333333333333333333333333",
            hex"0000000000000000000000000000000000000000000000000000000000007a69",
            hex"4444444444444444444444444444444444444444",
            hex"bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7",
            hex"5555555555555555555555555555555555555555555555555555555555555555",
            hex"0000000000000007",
            hex"6666666666666666666666666666666666666666666666666666666666666666",
            hex"00",
            hex"0000000000989680",
            hex"0000000001312d00"
        );
        assertBytesEqual(ProtocolEncoding.termsBytes(goldenTerms()), expected);
    }

    function testGoldenTermsHash() public pure {
        assert(ProtocolEncoding.termsHash(goldenTerms()) == GOLDEN_TERMS_HASH);
    }

    function testGoldenFilledReceipt() public pure {
        ProtocolEncoding.Receipt memory receipt = ProtocolEncoding.Receipt(GOLDEN_TERMS_HASH, 1, 20_000_000);
        bytes memory expected =
            hex"4343534c52433031081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8010000000001312d00";
        assertBytesEqual(ProtocolEncoding.receiptBytes(receipt), expected);
        assert(ProtocolEncoding.receiptHash(receipt) == GOLDEN_FILLED_HASH);
    }

    function testGoldenCancelledReceipt() public pure {
        ProtocolEncoding.Receipt memory receipt = ProtocolEncoding.Receipt(GOLDEN_TERMS_HASH, 2, 0);
        bytes memory expected =
            hex"4343534c52433031081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8020000000000000000";
        assertBytesEqual(ProtocolEncoding.receiptBytes(receipt), expected);
        assert(ProtocolEncoding.receiptHash(receipt) == GOLDEN_CANCELLED_HASH);
    }

    function testExactLengths() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        assert(ProtocolEncoding.identityBytes(terms.identity).length == 196);
        assert(ProtocolEncoding.termsBytes(terms).length == 277);
        assert(ProtocolEncoding.receiptBytes(ProtocolEncoding.Receipt(GOLDEN_TERMS_HASH, 1, 20_000_000)).length == 49);
        assert(ProtocolEncoding.receiptBytes(ProtocolEncoding.Receipt(GOLDEN_TERMS_HASH, 2, 0)).length == 49);
    }

    function testSourceDomainChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.domain.sourceDomain = bytes32(uint256(1));
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testDestinationDomainChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.domain.destinationDomain = bytes32(uint256(1));
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testProgramChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.domain.solanaProgram = bytes32(uint256(1));
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testChainIdChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.domain.chainId = 31338;
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testSettlementChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.domain.settlement = address(1);
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testUserChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.user = bytes32(uint256(1));
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testNonceChangesIdentity() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.nonce = 8;
        assert(ProtocolEncoding.orderId(terms.identity) != GOLDEN_ORDER_ID);
    }

    function testMarketChangesTermsOnly() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.market = bytes32(uint256(1));
        assertChangedTerms(terms);
    }

    function testOutcomeChangesTermsOnly() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.outcome = 1;
        assertChangedTerms(terms);
    }

    function testCashAmountChangesTermsOnly() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.cashAmount = 10_000_001;
        assertChangedTerms(terms);
    }

    function testMinimumSharesChangesTermsOnly() public pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.minimumShares = 20_000_001;
        assertChangedTerms(terms);
    }

    function testIntegerBoundaries() public pure {
        // Zero, asymmetric bytes, the amount-policy boundary, and full type maxima.
        // Encoding supports the full types; protocol amount/nonce policy is separate.
        assertIntegerEncoding(0, 0, 0, 0, 0, 0);
        assertIntegerEncoding(
            0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20,
            0x0102030405060708,
            0x9a,
            0x1122334455667788,
            0x8877665544332211,
            0xfedcba9876543210
        );
        assertIntegerEncoding(
            uint256(1) << 255, type(uint64).max - 1, 0, type(uint64).max / 2, type(uint64).max, type(uint64).max - 1
        );
        assertIntegerEncoding(
            type(uint256).max, type(uint64).max, type(uint8).max, type(uint64).max, type(uint64).max, type(uint64).max
        );
    }

    function testFuzzFieldWidthsAndHashConsistency(
        ProtocolEncoding.Terms memory terms,
        uint64 filledQuantity,
        bool cancelled
    ) public pure {
        bytes memory identity = ProtocolEncoding.identityBytes(terms.identity);
        bytes memory encodedTerms = ProtocolEncoding.termsBytes(terms);
        bytes32 orderId = ProtocolEncoding.orderId(terms.identity);
        bytes32 termsHash = ProtocolEncoding.termsHash(terms);
        assert(identity.length == 196);
        assert(encodedTerms.length == 277);
        assert(orderId == sha256(identity));
        assert(termsHash == sha256(encodedTerms));

        assertTag(identity, "CCSLID01");
        assertTag(encodedTerms, "CCSLTR01");
        assertDomainEncoding(identity, terms.identity.domain);
        assertDomainEncoding(encodedTerms, terms.identity.domain);
        assertUnsigned(identity, 156, 32, uint256(terms.identity.user));
        assertUnsigned(identity, 188, 8, terms.identity.nonce);
        assertUnsigned(encodedTerms, 156, 32, uint256(orderId));
        assertUnsigned(encodedTerms, 188, 32, uint256(terms.identity.user));
        assertUnsigned(encodedTerms, 220, 8, terms.identity.nonce);
        assertUnsigned(encodedTerms, 228, 32, uint256(terms.market));
        assertUnsigned(encodedTerms, 260, 1, terms.outcome);
        assertUnsigned(encodedTerms, 261, 8, terms.cashAmount);
        assertUnsigned(encodedTerms, 269, 8, terms.minimumShares);

        uint8 terminal = cancelled ? 2 : 1;
        ProtocolEncoding.Receipt memory receipt = ProtocolEncoding.Receipt(termsHash, terminal, filledQuantity);
        bytes memory encodedReceipt = ProtocolEncoding.receiptBytes(receipt);
        assert(encodedReceipt.length == 49);
        assert(ProtocolEncoding.receiptHash(receipt) == sha256(encodedReceipt));
        assertTag(encodedReceipt, "CCSLRC01");
        assertUnsigned(encodedReceipt, 8, 32, uint256(termsHash));
        assertUnsigned(encodedReceipt, 40, 1, terminal);
        assertUnsigned(encodedReceipt, 41, 8, filledQuantity);
    }

    function testFuzzRejectUnsupportedTerminal(uint8 terminal) public view {
        if (terminal == 1 || terminal == 2) return;
        ProtocolEncoding.Receipt memory receipt = ProtocolEncoding.Receipt(GOLDEN_TERMS_HASH, terminal, 0);
        try this.encodeReceipt(receipt) returns (bytes memory) {
            assert(false);
        } catch (bytes memory reason) {
            assertBytesEqual(reason, abi.encodeWithSelector(ProtocolEncoding.InvalidTerminal.selector, terminal));
        }
        try this.hashReceipt(receipt) returns (bytes32) {
            assert(false);
        } catch (bytes memory reason) {
            assertBytesEqual(reason, abi.encodeWithSelector(ProtocolEncoding.InvalidTerminal.selector, terminal));
        }
    }

    // External wrappers allow dependency-free assertions of the library's revert data.
    function encodeReceipt(ProtocolEncoding.Receipt memory receipt) external pure returns (bytes memory) {
        return ProtocolEncoding.receiptBytes(receipt);
    }

    function hashReceipt(ProtocolEncoding.Receipt memory receipt) external pure returns (bytes32) {
        return ProtocolEncoding.receiptHash(receipt);
    }

    function goldenTerms() private pure returns (ProtocolEncoding.Terms memory) {
        return ProtocolEncoding.Terms({
            identity: ProtocolEncoding.Identity({
                domain: ProtocolEncoding.Domain({
                    sourceDomain: 0x1111111111111111111111111111111111111111111111111111111111111111,
                    destinationDomain: 0x2222222222222222222222222222222222222222222222222222222222222222,
                    solanaProgram: 0x3333333333333333333333333333333333333333333333333333333333333333,
                    chainId: 31337,
                    settlement: 0x4444444444444444444444444444444444444444
                }),
                user: 0x5555555555555555555555555555555555555555555555555555555555555555,
                nonce: 7
            }),
            market: 0x6666666666666666666666666666666666666666666666666666666666666666,
            outcome: 0,
            cashAmount: 10_000_000,
            minimumShares: 20_000_000
        });
    }

    function assertChangedTerms(ProtocolEncoding.Terms memory terms) private pure {
        assert(ProtocolEncoding.orderId(terms.identity) == GOLDEN_ORDER_ID);
        assertBytesEqual(
            ProtocolEncoding.identityBytes(terms.identity), ProtocolEncoding.identityBytes(goldenTerms().identity)
        );
        assert(ProtocolEncoding.termsHash(terms) != GOLDEN_TERMS_HASH);
    }

    function assertIntegerEncoding(
        uint256 chainId,
        uint64 nonce,
        uint8 outcome,
        uint64 cashAmount,
        uint64 minimumShares,
        uint64 quantity
    ) private pure {
        ProtocolEncoding.Terms memory terms = goldenTerms();
        terms.identity.domain.chainId = chainId;
        terms.identity.nonce = nonce;
        terms.outcome = outcome;
        terms.cashAmount = cashAmount;
        terms.minimumShares = minimumShares;
        bytes memory identity = ProtocolEncoding.identityBytes(terms.identity);
        bytes memory encodedTerms = ProtocolEncoding.termsBytes(terms);
        assert(identity.length == 196);
        assert(encodedTerms.length == 277);
        assertUnsigned(identity, 104, 32, chainId);
        assertUnsigned(identity, 188, 8, nonce);
        assertUnsigned(encodedTerms, 104, 32, chainId);
        assertUnsigned(encodedTerms, 220, 8, nonce);
        assertUnsigned(encodedTerms, 260, 1, outcome);
        assertUnsigned(encodedTerms, 261, 8, cashAmount);
        assertUnsigned(encodedTerms, 269, 8, minimumShares);
        bytes memory receipt = ProtocolEncoding.receiptBytes(ProtocolEncoding.Receipt(GOLDEN_TERMS_HASH, 1, quantity));
        assert(receipt.length == 49);
        assertUnsigned(receipt, 41, 8, quantity);
    }

    function assertDomainEncoding(bytes memory encoded, ProtocolEncoding.Domain memory domain) private pure {
        assertUnsigned(encoded, 8, 32, uint256(domain.sourceDomain));
        assertUnsigned(encoded, 40, 32, uint256(domain.destinationDomain));
        assertUnsigned(encoded, 72, 32, uint256(domain.solanaProgram));
        assertUnsigned(encoded, 104, 32, domain.chainId);
        assertUnsigned(encoded, 136, 20, uint160(domain.settlement));
    }

    /// @dev Independent byte-by-byte big-endian check, without abi.encodePacked.
    function assertUnsigned(bytes memory encoded, uint256 offset, uint256 width, uint256 value) private pure {
        assert(offset + width <= encoded.length);
        for (uint256 i; i < width; ++i) {
            assert(uint8(encoded[offset + i]) == ((value >> (8 * (width - 1 - i))) & 0xff));
        }
    }

    function assertTag(bytes memory encoded, bytes8 tag) private pure {
        for (uint256 i; i < 8; ++i) {
            assert(encoded[i] == tag[i]);
        }
    }

    function assertBytesEqual(bytes memory actual, bytes memory expected) private pure {
        assert(actual.length == expected.length);
        for (uint256 i; i < expected.length; ++i) {
            assert(actual[i] == expected[i]);
        }
    }
}
