// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Settlement} from "../src/Settlement.sol";
import {ProtocolEncoding} from "../src/ProtocolEncoding.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";

interface CancellationTestVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address caller) external;
    function expectRevert(bytes calldata reason) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function chainId(uint256 chainId_) external;
}

/// @dev Test-only metadata double; never used to fabricate terminal records.
contract CancellationDecimalsStub {
    uint8 private immutable DECIMALS;

    constructor(uint8 decimals_) {
        DECIMALS = decimals_;
    }

    function decimals() external view returns (uint8) {
        return DECIMALS;
    }
}

/// @dev Dependency-free tests with funded custody/inventory and finite allowances.
contract SettlementCancellationTest {
    CancellationTestVm private constant VM =
        CancellationTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0x0F);
    address private constant EXECUTOR = address(0xE);
    address private constant STRANGER = address(0xBAD);
    bytes32 private constant SOURCE = bytes32(uint256(0x11));
    bytes32 private constant DESTINATION = bytes32(uint256(0x22));
    bytes32 private constant PROGRAM = bytes32(uint256(0x33));
    bytes32 private constant USER = bytes32(uint256(0x55));
    bytes32 private constant MARKET = bytes32(uint256(0x66));
    uint64 private constant CASH = 10_000_000;
    uint64 private constant MINIMUM = 20_000_000;
    uint64 private constant MAX_CASH = type(uint64).max / 2;
    MockERC20 private usd;
    MockERC20 private yes;
    MockVenue private venue;
    Settlement private settlement;

    function setUp() public {
        usd = new MockERC20("Mock USD", "mUSD", address(this));
        yes = new MockERC20("Mock YES", "mYES", address(this));
        venue = new MockVenue(address(usd), address(yes), MARKET);
        settlement = new Settlement(configuration());
        usd.mint(EXECUTOR, 3 * CASH);
        usd.mint(address(venue), CASH);
        usd.mint(address(settlement), 1_000);
        yes.mint(address(venue), 3 * MINIMUM);
        yes.mint(EXECUTOR, MINIMUM);
        yes.mint(address(settlement), 2_000);
        VM.prank(EXECUTOR);
        assert(usd.approve(address(settlement), 2 * CASH));
        VM.prank(EXECUTOR);
        assert(yes.approve(address(settlement), MINIMUM));
        VM.prank(address(settlement));
        assert(usd.approve(address(venue), 500));
        VM.prank(address(settlement));
        assert(yes.approve(STRANGER, 700));
        VM.prank(address(venue));
        assert(yes.approve(address(settlement), MINIMUM));
    }

    function testValidConfigurationAndGetters() public view {
        ProtocolEncoding.Domain memory actual = settlement.domain();
        assert(actual.sourceDomain == SOURCE && actual.destinationDomain == DESTINATION);
        assert(actual.solanaProgram == PROGRAM && actual.chainId == block.chainid);
        assert(actual.settlement == address(settlement));
        assert(settlement.operator() == OPERATOR && settlement.executor() == EXECUTOR);
        assert(settlement.usdToken() == address(usd) && settlement.yesToken() == address(yes));
        assert(settlement.venue() == address(venue) && settlement.market() == MARKET);
        assert(uint8(Settlement.State.Unseen) == 0);
        assert(uint8(Settlement.State.Filled) == 1 && uint8(Settlement.State.Cancelled) == 2);
        assert(usd.balanceOf(EXECUTOR) == 3 * CASH && yes.balanceOf(address(venue)) == 3 * MINIMUM);
        assert(usd.balanceOf(address(settlement)) == 1_000 && yes.balanceOf(address(settlement)) == 2_000);
        assert(usd.allowance(EXECUTOR, address(settlement)) == 2 * CASH);
        assert(usd.allowance(address(settlement), address(venue)) == 500);
    }

    function testRejectInvalidConstructorIdentities() public {
        for (uint256 i; i < 4; ++i) {
            Settlement.Configuration memory config = configuration();
            if (i == 0) config.sourceDomain = bytes32(0);
            if (i == 1) config.destinationDomain = bytes32(0);
            if (i == 2) config.destinationDomain = config.sourceDomain;
            if (i == 3) config.solanaProgram = bytes32(0);
            assertDeploymentFailure(
                config,
                abi.encodeWithSelector(i == 3 ? Settlement.InvalidProgram.selector : Settlement.InvalidDomains.selector)
            );
        }
    }

    function testRejectZeroConstructorAddressesAndIdenticalTokens() public {
        for (uint256 i; i < 6; ++i) {
            Settlement.Configuration memory config = configuration();
            if (i == 0) config.operator = address(0);
            if (i == 1) config.executor = address(0);
            if (i == 2) config.venue = address(0);
            if (i == 3) config.usdToken = address(0);
            if (i == 4) config.yesToken = address(0);
            if (i == 5) config.yesToken = config.usdToken;
            assertDeploymentFailure(
                config,
                abi.encodeWithSelector(i < 3 ? Settlement.InvalidAddress.selector : Settlement.InvalidTokens.selector)
            );
        }
    }

    function testRejectZeroConstructorMarket() public {
        Settlement.Configuration memory config = configuration();
        config.market = bytes32(0);
        assertDeploymentFailure(config, abi.encodeWithSelector(Settlement.InvalidMarket.selector, bytes32(0)));
    }

    function testRejectWrongDecimalsForEitherToken() public {
        CancellationDecimalsStub wrong = new CancellationDecimalsStub(18);
        Settlement.Configuration memory config = configuration();
        config.usdToken = address(wrong);
        assertDeploymentFailure(config, abi.encodeWithSelector(Settlement.InvalidDecimals.selector));
        config = configuration();
        config.yesToken = address(wrong);
        assertDeploymentFailure(config, abi.encodeWithSelector(Settlement.InvalidDecimals.selector));
    }

    function testRejectVenueTokenAndMarketMismatches() public {
        MockERC20 other = new MockERC20("Other", "OTHER", address(this));
        for (uint256 i; i < 3; ++i) {
            Settlement.Configuration memory config = configuration();
            if (i == 0) config.venue = address(new MockVenue(address(other), address(yes), MARKET));
            if (i == 1) config.venue = address(new MockVenue(address(usd), address(other), MARKET));
            if (i == 2) config.venue = address(new MockVenue(address(usd), address(yes), bytes32(uint256(1))));
            assertDeploymentFailure(config, abi.encodeWithSelector(Settlement.InvalidVenueBindings.selector));
        }
    }

    function testUnknownOrderHasNoTermsOrTerminalReceipt() public view {
        Settlement.OrderRecord memory empty;
        Settlement.OrderRecord memory record = settlement.orderRecord(ProtocolEncoding.orderId(defaultTerms().identity));
        assert(record.status == Settlement.State.Unseen);
        assert(record.termsHash == bytes32(0) && record.receiptHash == bytes32(0));
        assert(record.filledQuantity == 0);
        assert(keccak256(abi.encode(record)) == keccak256(abi.encode(empty)));
    }

    function testCancellationExactRecordReceiptAndEvent() public {
        assertCancellation(defaultTerms());
    }

    function testDuplicateCancellationPreservesEveryFieldAndEmitsNoEvent() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertCancellation(terms);
        assertReplay(terms);
    }

    function testUnauthorizedUnseenAndCancelledRequests() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        bytes memory expected = abi.encodeWithSelector(Settlement.UnauthorizedOperator.selector);
        assertRequestFailure(STRANGER, id, terms, expected);
        assertRequestFailure(EXECUTOR, id, terms, expected);
        assertCancellation(terms);
        assertRequestFailure(STRANGER, id, terms, expected);
        assertRequestFailure(EXECUTOR, id, terms, expected);
    }

    function testWrongDomainsBeforeCreationAndReplay() public {
        ProtocolEncoding.Terms memory valid = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(valid.identity);
        for (uint256 phase; phase < 2; ++phase) {
            for (uint256 i; i < 5; ++i) {
                ProtocolEncoding.Terms memory terms = defaultTerms();
                if (i == 0) terms.identity.domain.sourceDomain = bytes32(uint256(1));
                if (i == 1) terms.identity.domain.destinationDomain = bytes32(uint256(1));
                if (i == 2) terms.identity.domain.solanaProgram = bytes32(uint256(1));
                if (i == 3) terms.identity.domain.chainId += 1;
                if (i == 4) terms.identity.domain.settlement = STRANGER;
                // Test the existing ID as well as a canonical ID in the wrong domain.
                bytes memory expected = abi.encodeWithSelector(Settlement.InvalidRequestDomain.selector);
                assertRequestFailure(OPERATOR, id, terms, expected);
                assertRequestFailure(OPERATOR, ProtocolEncoding.orderId(terms.identity), terms, expected);
            }
            if (phase == 0) assertCancellation(valid);
        }
    }

    function testLiveChainIdChangeRejectsCreationAndExactReplay() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        uint256 captured = terms.identity.domain.chainId;
        bytes memory expected = abi.encodeWithSelector(Settlement.ChainIdChanged.selector);
        VM.chainId(captured + 1);
        assert(settlement.domain().chainId == captured);
        assertRequestFailure(OPERATOR, id, terms, expected);
        terms.identity.domain.chainId = captured + 1;
        assertRequestFailure(OPERATOR, ProtocolEncoding.orderId(terms.identity), terms, expected);
        VM.chainId(captured);
        terms = defaultTerms();
        assertCancellation(terms);
        VM.chainId(captured + 1);
        assertRequestFailure(OPERATOR, id, terms, expected);
        VM.chainId(captured);
        assertReplay(terms);
    }

    function testWrongSuppliedIdAndIdentityCannotReuseRecord() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        bytes memory expected = abi.encodeWithSelector(Settlement.InvalidOrderId.selector);
        assertRequestFailure(OPERATOR, bytes32(0), terms, expected);
        assertCancellation(terms);
        terms.identity.user = bytes32(uint256(1));
        assertRequestFailure(OPERATOR, id, terms, expected);
        terms = defaultTerms();
        terms.identity.nonce += 1;
        assertRequestFailure(OPERATOR, id, terms, expected);
        assertReplay(defaultTerms());
    }

    function testRejectZeroUserAndMaximumNonce() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.identity.user = bytes32(0);
        assertInvalidTerms(terms, abi.encodeWithSelector(Settlement.InvalidUser.selector));
        terms = defaultTerms();
        terms.identity.nonce = type(uint64).max;
        assertInvalidTerms(terms, abi.encodeWithSelector(Settlement.InvalidNonce.selector));
    }

    function testInvalidMarketOutcomeAndAmountsBeforeCreationAndReplay() public {
        bytes32 id = ProtocolEncoding.orderId(defaultTerms().identity);
        for (uint256 phase; phase < 2; ++phase) {
            for (uint256 i; i < 8; ++i) {
                ProtocolEncoding.Terms memory terms = defaultTerms();
                bytes memory expected;
                if (i < 2) {
                    terms.market = i == 0 ? bytes32(0) : bytes32(uint256(1));
                    expected = abi.encodeWithSelector(Settlement.InvalidMarket.selector, terms.market);
                } else if (i < 4) {
                    terms.outcome = i == 2 ? 1 : type(uint8).max;
                    expected = abi.encodeWithSelector(Settlement.InvalidOutcome.selector, terms.outcome);
                } else if (i < 7) {
                    terms.cashAmount = i == 4 ? 0 : (i == 5 ? MAX_CASH + 1 : type(uint64).max);
                    expected = abi.encodeWithSelector(Settlement.InvalidCashAmount.selector, terms.cashAmount);
                } else {
                    terms.minimumShares = 0;
                    expected = abi.encodeWithSelector(Settlement.InvalidMinimumShares.selector);
                }
                assertRequestFailure(OPERATOR, id, terms, expected);
            }
            if (phase == 0) assertCancellation(defaultTerms());
        }
    }

    function testNonceZeroLastUsableNonceAndMaximumValidCash() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.identity.nonce = 0;
        terms.cashAmount = 1;
        terms.minimumShares = 1;
        assertCancellation(terms);
        assertReplay(terms);
        terms.identity.nonce = type(uint64).max - 1;
        terms.cashAmount = MAX_CASH;
        terms.minimumShares = type(uint64).max;
        assertCancellation(terms);
        assertReplay(terms);
    }

    function testUnattainablePositiveMinimumStillCancels() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.minimumShares = MINIMUM + 1;
        assertCancellation(terms);
        assertReplay(terms);
    }

    function testChangedCashOrMinimumConflictsWithSameIdAndPreservesRecord() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertCancellation(terms);
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        bytes32 storedHash = ProtocolEncoding.termsHash(terms);
        terms.cashAmount += 1;
        assertConflict(id, storedHash, terms);
        terms = defaultTerms();
        terms.minimumShares += 1;
        assertConflict(id, storedHash, terms);
        assertReplay(defaultTerms());
    }

    function testDistinctUsersAndNoncesHaveIndependentPermanentRecords() public {
        ProtocolEncoding.Terms memory alice = defaultTerms();
        ProtocolEncoding.Terms memory bob = defaultTerms();
        ProtocolEncoding.Terms memory next = defaultTerms();
        bob.identity.user = bytes32(uint256(0x77));
        bob.cashAmount = CASH + 1;
        next.identity.nonce += 1;
        next.minimumShares = MINIMUM + 1;
        bytes32 aliceId = ProtocolEncoding.orderId(alice.identity);
        bytes32 bobId = ProtocolEncoding.orderId(bob.identity);
        bytes32 nextId = ProtocolEncoding.orderId(next.identity);
        assert(aliceId != bobId && aliceId != nextId && bobId != nextId);
        assertCancellation(alice);
        bytes32 aliceRecord = recordDigest(aliceId);
        assertCancellation(bob);
        assert(recordDigest(aliceId) == aliceRecord);
        bytes32 bobRecord = recordDigest(bobId);
        assertCancellation(next);
        assert(recordDigest(aliceId) == aliceRecord && recordDigest(bobId) == bobRecord);
        assertReplay(alice);
        assertReplay(bob);
        assertReplay(next);
    }

    function testFuzzValidCancellationReplayAndValidTermConflict(
        bytes32 rawUser,
        uint64 rawNonce,
        uint64 rawCash,
        uint64 rawMinimum,
        bool changeCash
    ) public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.identity.user = rawUser == bytes32(0) ? USER : rawUser;
        terms.identity.nonce = rawNonce % type(uint64).max;
        terms.cashAmount = rawCash % MAX_CASH + 1;
        terms.minimumShares = rawMinimum == 0 ? 1 : rawMinimum;
        assertCancellation(terms);
        assertReplay(terms);
        // Copy through ABI to keep the original nested memory terms independent.
        ProtocolEncoding.Terms memory changed = abi.decode(abi.encode(terms), (ProtocolEncoding.Terms));
        if (changeCash) changed.cashAmount = terms.cashAmount == MAX_CASH ? MAX_CASH - 1 : terms.cashAmount + 1;
        else changed.minimumShares = terms.minimumShares == type(uint64).max ? 1 : terms.minimumShares + 1;
        assertConflict(ProtocolEncoding.orderId(terms.identity), ProtocolEncoding.termsHash(terms), changed);
        assertReplay(terms);
    }

    function configuration() private view returns (Settlement.Configuration memory) {
        return Settlement.Configuration(
            SOURCE, DESTINATION, PROGRAM, OPERATOR, EXECUTOR, address(usd), address(yes), address(venue), MARKET
        );
    }

    function defaultTerms() private view returns (ProtocolEncoding.Terms memory) {
        return ProtocolEncoding.Terms(ProtocolEncoding.Identity(settlement.domain(), USER, 7), MARKET, 0, CASH, MINIMUM);
    }

    function assertDeploymentFailure(Settlement.Configuration memory config, bytes memory expected) private {
        bytes32 before = economicDigest();
        VM.expectRevert(expected);
        new Settlement(config);
        assert(economicDigest() == before);
    }

    function assertInvalidTerms(ProtocolEncoding.Terms memory terms, bytes memory expected) private {
        assertRequestFailure(OPERATOR, ProtocolEncoding.orderId(terms.identity), terms, expected);
    }

    function assertRequestFailure(
        address caller,
        bytes32 id,
        ProtocolEncoding.Terms memory terms,
        bytes memory expected
    ) private {
        bytes32 beforeEconomics = economicDigest();
        bytes32 beforeRecord = recordDigest(id);
        VM.recordLogs();
        VM.prank(caller);
        (bool success, bytes memory reason) = address(settlement).call(abi.encodeCall(settlement.cancel, (id, terms)));
        assert(!success && keccak256(reason) == keccak256(expected));
        assert(VM.getRecordedLogs().length == 0);
        assert(recordDigest(id) == beforeRecord && economicDigest() == beforeEconomics);
    }

    function assertConflict(bytes32 id, bytes32 storedHash, ProtocolEncoding.Terms memory changed) private {
        assert(ProtocolEncoding.orderId(changed.identity) == id);
        assertRequestFailure(
            OPERATOR,
            id,
            changed,
            abi.encodeWithSelector(
                Settlement.TermsConflict.selector, id, storedHash, ProtocolEncoding.termsHash(changed)
            )
        );
    }

    function assertCancellation(ProtocolEncoding.Terms memory terms) private {
        bytes32 before = economicDigest();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assert(settlement.orderRecord(id).status == Settlement.State.Unseen);
        bytes32 termsHash = ProtocolEncoding.termsHash(terms);
        ProtocolEncoding.Receipt memory expected = ProtocolEncoding.Receipt(termsHash, 2, 0);
        bytes32 receiptHash = ProtocolEncoding.receiptHash(expected);
        VM.recordLogs();
        VM.prank(OPERATOR);
        ProtocolEncoding.Receipt memory actual = settlement.cancel(id, terms);
        assert(keccak256(abi.encode(actual)) == keccak256(abi.encode(expected)));
        CancellationTestVm.Log[] memory logs = VM.getRecordedLogs();
        assert(logs.length == 1 && logs[0].emitter == address(settlement));
        assert(logs[0].topics.length == 3);
        assert(logs[0].topics[0] == keccak256("TerminalRecorded(bytes32,bytes32,uint8,uint64,bytes32)"));
        assert(logs[0].topics[1] == id && logs[0].topics[2] == termsHash);
        assert(keccak256(logs[0].data) == keccak256(abi.encode(uint8(2), uint64(0), receiptHash)));
        Settlement.OrderRecord memory record = settlement.orderRecord(id);
        assert(keccak256(abi.encode(record.terms)) == keccak256(abi.encode(terms)));
        assert(record.termsHash == termsHash && record.status == Settlement.State.Cancelled);
        assert(record.filledQuantity == 0 && record.receiptHash == receiptHash);
        assert(economicDigest() == before);
    }

    function assertReplay(ProtocolEncoding.Terms memory terms) private {
        bytes32 before = economicDigest();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        bytes32 beforeRecord = recordDigest(id);
        Settlement.OrderRecord memory record = settlement.orderRecord(id);
        VM.recordLogs();
        VM.prank(OPERATOR);
        ProtocolEncoding.Receipt memory receipt = settlement.cancel(id, terms);
        assert(VM.getRecordedLogs().length == 0);
        assert(receipt.termsHash == record.termsHash && receipt.terminal == 2 && receipt.filledQuantity == 0);
        assert(ProtocolEncoding.receiptHash(receipt) == record.receiptHash);
        assert(recordDigest(id) == beforeRecord && economicDigest() == before);
    }

    function recordDigest(bytes32 id) private view returns (bytes32) {
        return keccak256(abi.encode(settlement.orderRecord(id)));
    }

    /// @dev Snapshot both supplies, every fixture balance, and every allowance
    ///      between fixture actors, including zero entries and finite permissions.
    function economicDigest() private view returns (bytes32) {
        address[7] memory actors =
            [EXECUTOR, OPERATOR, STRANGER, address(settlement), address(venue), address(this), address(0)];
        MockERC20[2] memory tokens = [usd, yes];
        uint256[2] memory supplies;
        uint256[14] memory balances;
        uint256[98] memory allowances;
        for (uint256 t; t < 2; ++t) {
            supplies[t] = tokens[t].totalSupply();
            for (uint256 i; i < 7; ++i) {
                balances[t * 7 + i] = tokens[t].balanceOf(actors[i]);
                for (uint256 j; j < 7; ++j) {
                    allowances[t * 49 + i * 7 + j] = tokens[t].allowance(actors[i], actors[j]);
                }
            }
        }
        return keccak256(abi.encode(supplies, balances, allowances));
    }
}
