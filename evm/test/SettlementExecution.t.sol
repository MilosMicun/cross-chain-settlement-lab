// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Settlement} from "../src/Settlement.sol";
import {ProtocolEncoding} from "../src/ProtocolEncoding.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";

interface ExecutionTestVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function chainId(uint256 chainId_) external;
}

/// @dev Isolated adversarial venue, never part of the plain-token demo fixture.
contract ExecutionVenueDouble {
    MockERC20 private immutable USD_TOKEN;
    MockERC20 private immutable YES_TOKEN;
    bytes32 private immutable MARKET;
    uint256 public mode;
    uint256 public purchases;
    ProtocolEncoding.Terms private callbackTerms;
    bytes32 public executeError;
    bytes32 public cancelError;
    bytes32 public outerCancelError;

    constructor(MockERC20 usd_, MockERC20 yes_, bytes32 market_, uint256 mode_) {
        USD_TOKEN = usd_;
        YES_TOKEN = yes_;
        MARKET = market_;
        mode = mode_;
    }

    function arm(ProtocolEncoding.Terms memory terms) external {
        callbackTerms = terms;
    }

    function usdToken() external view returns (MockERC20) {
        return USD_TOKEN;
    }

    function yesToken() external view returns (MockERC20) {
        return YES_TOKEN;
    }

    function market() external view returns (bytes32) {
        return MARKET;
    }

    function buy(bytes32 market_, uint8 outcome, uint64 cash, uint64 minimum) external returns (uint64 quantity) {
        assert(market_ == MARKET && outcome == 0);
        ++purchases;
        quantity = cash * 2;
        assert(USD_TOKEN.allowance(msg.sender, address(this)) == cash);
        // Mode 3 deliberately preserves cash instead of paying the venue.
        if (mode != 3) assert(USD_TOKEN.transferFrom(msg.sender, address(this), cash));
        if (mode >= 5) {
            Settlement target = Settlement(msg.sender);
            assert(target.operator() == address(this));
            assert(USD_TOKEN.balanceOf(address(this)) == cash && USD_TOKEN.balanceOf(msg.sender) == 0);
            assert(USD_TOKEN.allowance(msg.sender, address(this)) == 0);
            assert(YES_TOKEN.balanceOf(msg.sender) == 0);
            assert(target.totalCashSpent() == 0 && target.totalSharesPurchased() == 0);
            ProtocolEncoding.Terms memory outer = callbackTerms;
            assert(target.orderRecord(ProtocolEncoding.orderId(outer.identity)).status == Settlement.State.Unseen);
            ProtocolEncoding.Terms memory nested = abi.decode(abi.encode(outer), (ProtocolEncoding.Terms));
            ++nested.identity.nonce;
            bytes32 nestedId = ProtocolEncoding.orderId(nested.identity);
            (bool executed, bytes memory executionReason) =
                msg.sender.call(abi.encodeCall(target.execute, (nestedId, nested)));
            (bool cancelled, bytes memory cancellationReason) =
                msg.sender.call(abi.encodeCall(target.cancel, (nestedId, nested)));
            (bool outerCancelled, bytes memory outerReason) =
                msg.sender.call(abi.encodeCall(target.cancel, (ProtocolEncoding.orderId(outer.identity), outer)));
            assert(!executed && !cancelled && !outerCancelled);
            executeError = keccak256(executionReason);
            cancelError = keccak256(cancellationReason);
            outerCancelError = keccak256(outerReason);
            if (mode == 6) {
                // Bubble the actual nested guard failure to revert the outer payment.
                assembly ("memory-safe") {
                    revert(add(executionReason, 32), mload(executionReason))
                }
            }
            assert(target.orderRecord(nestedId).status == Settlement.State.Unseen);
        }
        assert(YES_TOKEN.transfer(msg.sender, mode == 2 ? quantity - 1 : quantity));
        // Mode 4 ignores an unattainable minimum; settlement must still enforce it.
        if (mode != 4) assert(quantity >= minimum);
        if (mode == 1) return quantity - 1;
    }
}

/// @dev Isolated cash-call double for explicit false returns and inaccurate transfers.
contract ExecutionCashDouble {
    enum Mode {
        FalsePull,
        FalseApprove,
        FalseReset,
        LyingReset,
        ShortPull
    }

    Mode private immutable MODE;
    address private immutable PAYER;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(Mode mode_, address payer_) {
        MODE = mode_;
        PAYER = payer_;
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address owner, uint256 amount) external {
        balanceOf[owner] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (MODE == Mode.FalseApprove && msg.sender != PAYER) return false;
        if (MODE == Mode.FalseReset && amount == 0) return false;
        allowance[msg.sender][spender] = MODE == Mode.LyingReset && amount == 0 ? 1 : amount;
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        if (MODE == Mode.FalsePull) return false;
        assert(balanceOf[owner] >= amount && allowance[owner][msg.sender] >= amount);
        allowance[owner][msg.sender] -= amount;
        balanceOf[owner] -= amount;
        balanceOf[recipient] += MODE == Mode.ShortPull ? amount - 1 : amount;
        return true;
    }
}

/// @dev Dependency-free execution tests. Real mock tokens/venue cover normal economics.
contract SettlementExecutionTest {
    ExecutionTestVm private constant VM = ExecutionTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0x0F);
    address private constant EXECUTOR = address(0xE);
    address private constant STRANGER = address(0xBAD);
    bytes32 private constant SOURCE = bytes32(uint256(0x11));
    bytes32 private constant DESTINATION = bytes32(uint256(0x22));
    bytes32 private constant PROGRAM = bytes32(uint256(0x33));
    bytes32 private constant USER = bytes32(uint256(0x55));
    bytes32 private constant MARKET = bytes32(uint256(0x66));
    uint64 private constant CASH = 10_000_000;
    uint64 private constant SHARES = 20_000_000;
    uint64 private constant MAX_CASH = type(uint64).max / 2;
    bytes32 private constant TERMINAL_EVENT = keccak256("TerminalRecorded(bytes32,bytes32,uint8,uint64,bytes32)");
    MockERC20 private usd;
    MockERC20 private yes;
    MockVenue private venue;
    Settlement private settlement;

    struct Ledger {
        uint256 executorCash;
        uint256 operatorCash;
        uint256 venueCash;
        uint256 custodyCash;
        uint256 executorYes;
        uint256 operatorYes;
        uint256 venueYes;
        uint256 custodyYes;
        uint256 executorAllowance;
        uint256 venueAllowance;
        uint256 cashSupply;
        uint256 yesSupply;
        uint128 cashSpent;
        uint128 sharesPurchased;
    }

    function setUp() public {
        fixture(3 * CASH, 3 * SHARES, 3 * CASH);
    }

    function testHappyPathExactEconomicsRecordReceiptAndEvents() public {
        assert(OPERATOR != EXECUTOR && usd.balanceOf(OPERATOR) == 0);
        assert(settlement.totalCashSpent() == 0 && settlement.totalSharesPurchased() == 0);
        assertFill(defaultTerms());
        assert(usd.balanceOf(EXECUTOR) == 2 * CASH);
        assert(usd.balanceOf(address(venue)) == CASH && usd.balanceOf(address(settlement)) == 0);
        assert(yes.balanceOf(address(settlement)) == SHARES && yes.balanceOf(address(venue)) == 2 * SHARES);
        assert(usd.allowance(EXECUTOR, address(settlement)) == 2 * CASH);
        assert(usd.allowance(address(settlement), address(venue)) == 0);
        assert(settlement.totalCashSpent() == CASH && settlement.totalSharesPurchased() == SHARES);
    }

    function testFilledExecuteReplayAndCancelReturnRealStoredReceipt() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertFill(terms);
        assertReplay(terms, true);
        assertReplay(terms, false);
        assertReplay(terms, true);
    }

    function testReplayNeedsNeitherLiquidityInventoryNorAllowance() public {
        fixture(CASH, SHARES, CASH);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertFill(terms);
        assert(usd.balanceOf(EXECUTOR) == 0 && yes.balanceOf(address(venue)) == 0);
        assert(usd.allowance(EXECUTOR, address(settlement)) == 0);
        assertReplay(terms, true);
        assertReplay(terms, false);
    }

    function testCancelWinsPermanentlyAndRepeatedCancelIsInert() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assertCancellation(terms);
        assertReplay(terms, false);
        assertFailure(OPERATOR, id, terms, abi.encodeWithSelector(Settlement.OrderCancelled.selector, id), true);
        assertReplay(terms, false);
    }

    function testChangedValidTermsConflictForBothApisAndBothTerminalStates() public {
        for (uint64 phase; phase < 2; ++phase) {
            ProtocolEncoding.Terms memory terms = defaultTerms();
            terms.identity.nonce += phase;
            if (phase == 0) assertFill(terms);
            else assertCancellation(terms);
            bytes32 id = ProtocolEncoding.orderId(terms.identity);
            bytes32 storedHash = ProtocolEncoding.termsHash(terms);
            for (uint256 field; field < 2; ++field) {
                ProtocolEncoding.Terms memory changed = abi.decode(abi.encode(terms), (ProtocolEncoding.Terms));
                if (field == 0) ++changed.cashAmount;
                else ++changed.minimumShares;
                bytes memory expected = abi.encodeWithSelector(
                    Settlement.TermsConflict.selector, id, storedHash, ProtocolEncoding.termsHash(changed)
                );
                assertFailure(OPERATOR, id, changed, expected, true);
                assertFailure(OPERATOR, id, changed, expected, false);
            }
            assertReplay(terms, false);
        }
    }

    function testDistinctFilledOrdersAccumulateAndRemainImmutable() public {
        ProtocolEncoding.Terms memory first = defaultTerms();
        assertFill(first);
        bytes32 firstId = ProtocolEncoding.orderId(first.identity);
        bytes32 firstRecord = recordDigest(firstId);
        ProtocolEncoding.Terms memory second = defaultTerms();
        ++second.identity.nonce;
        second.cashAmount = CASH + 1;
        second.minimumShares = 1;
        assertFill(second);
        assert(recordDigest(firstId) == firstRecord);
        assert(settlement.totalCashSpent() == 2 * uint128(CASH) + 1);
        assert(settlement.totalSharesPurchased() == 2 * uint128(SHARES) + 2);
        assertReplay(first, true);
        assertReplay(second, false);
        ProtocolEncoding.Terms memory cancelled = defaultTerms();
        cancelled.identity.nonce += 2;
        assertCancellation(cancelled);
    }

    function testUnauthorizedExecutionBeforeCreationAndBothTerminalReplays() public {
        for (uint64 phase; phase < 3; ++phase) {
            ProtocolEncoding.Terms memory terms = defaultTerms();
            terms.identity.nonce += phase;
            if (phase == 1) assertFill(terms);
            if (phase == 2) assertCancellation(terms);
            bytes memory expected = abi.encodeWithSelector(Settlement.UnauthorizedOperator.selector);
            bytes32 id = ProtocolEncoding.orderId(terms.identity);
            assertFailure(STRANGER, id, terms, expected, true);
            assertFailure(EXECUTOR, id, terms, expected, true);
            if (phase == 1) assertFailure(STRANGER, id, terms, expected, false);
        }
    }

    function testWrongDomainsBeforeCreationAndFilledReplay() public {
        ProtocolEncoding.Terms memory valid = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(valid.identity);
        for (uint256 phase; phase < 2; ++phase) {
            for (uint256 field; field < 5; ++field) {
                ProtocolEncoding.Terms memory terms = defaultTerms();
                if (field == 0) terms.identity.domain.sourceDomain = bytes32(uint256(1));
                if (field == 1) terms.identity.domain.destinationDomain = bytes32(uint256(1));
                if (field == 2) terms.identity.domain.solanaProgram = bytes32(uint256(1));
                if (field == 3) ++terms.identity.domain.chainId;
                if (field == 4) terms.identity.domain.settlement = STRANGER;
                bytes memory expected = abi.encodeWithSelector(Settlement.InvalidRequestDomain.selector);
                assertFailure(OPERATOR, id, terms, expected, true);
                assertFailure(OPERATOR, ProtocolEncoding.orderId(terms.identity), terms, expected, true);
                if (phase == 1) assertFailure(OPERATOR, id, terms, expected, false);
            }
            if (phase == 0) assertFill(valid);
        }
    }

    function testChangedCurrentChainRejectsCreationAndFilledReplay() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        uint256 captured = block.chainid;
        bytes memory expected = abi.encodeWithSelector(Settlement.ChainIdChanged.selector);
        VM.chainId(captured + 1);
        assertFailure(OPERATOR, id, terms, expected, true);
        assert(settlement.domain().chainId == captured);
        VM.chainId(captured);
        assertFill(terms);
        VM.chainId(captured + 1);
        assertFailure(OPERATOR, id, terms, expected, true);
        assertFailure(OPERATOR, id, terms, expected, false);
        VM.chainId(captured);
        assertReplay(terms, true);
    }

    function testWrongIdUserAndNonceCannotReuseFilledRecord() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        bytes memory expected = abi.encodeWithSelector(Settlement.InvalidOrderId.selector);
        assertFailure(OPERATOR, bytes32(0), terms, expected, true);
        assertFill(terms);
        terms.identity.user = bytes32(uint256(1));
        assertFailure(OPERATOR, id, terms, expected, true);
        terms = defaultTerms();
        ++terms.identity.nonce;
        assertFailure(OPERATOR, id, terms, expected, true);
        assertReplay(defaultTerms(), true);
    }

    function testZeroUserAndInvalidNonceThroughExecution() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.identity.user = bytes32(0);
        assertFailure(
            OPERATOR,
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(Settlement.InvalidUser.selector),
            true
        );
        terms = defaultTerms();
        terms.identity.nonce = type(uint64).max;
        assertFailure(
            OPERATOR,
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(Settlement.InvalidNonce.selector),
            true
        );
    }

    function testInvalidMarketOutcomeCashAndMinimumBeforeCreationAndFilledReplay() public {
        bytes32 id = ProtocolEncoding.orderId(defaultTerms().identity);
        for (uint256 phase; phase < 2; ++phase) {
            for (uint256 field; field < 8; ++field) {
                ProtocolEncoding.Terms memory terms = defaultTerms();
                bytes memory expected;
                if (field < 2) {
                    terms.market = field == 0 ? bytes32(0) : bytes32(uint256(1));
                    expected = abi.encodeWithSelector(Settlement.InvalidMarket.selector, terms.market);
                } else if (field < 4) {
                    terms.outcome = field == 2 ? 1 : type(uint8).max;
                    expected = abi.encodeWithSelector(Settlement.InvalidOutcome.selector, terms.outcome);
                } else if (field < 7) {
                    terms.cashAmount = field == 4 ? 0 : (field == 5 ? MAX_CASH + 1 : type(uint64).max);
                    expected = abi.encodeWithSelector(Settlement.InvalidCashAmount.selector, terms.cashAmount);
                } else {
                    terms.minimumShares = 0;
                    expected = abi.encodeWithSelector(Settlement.InvalidMinimumShares.selector);
                }
                assertFailure(OPERATOR, id, terms, expected, true);
                if (phase == 1) assertFailure(OPERATOR, id, terms, expected, false);
            }
            if (phase == 0) assertFill(defaultTerms());
        }
    }

    function testMissingAllowanceRollbackAndRetry() public {
        allowanceFailureAndRetry(0);
    }

    function testInsufficientAllowanceRollbackAndRetry() public {
        allowanceFailureAndRetry(CASH - 1);
    }

    function testInsufficientExecutorCashRollbackAndRetry() public {
        fixture(CASH - 1, SHARES, CASH);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertFailure(
            OPERATOR,
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(MockERC20.InsufficientBalance.selector),
            true
        );
        usd.mint(EXECUTOR, 1);
        assertFill(terms);
        assertReplay(terms, true);
    }

    function testUnattainableMinimumRollsBackThenCanBeCancelled() public {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.minimumShares = SHARES + 1;
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assertFailure(
            OPERATOR, id, terms, abi.encodeWithSelector(MockVenue.MinimumNotMet.selector, SHARES, SHARES + 1), true
        );
        // More inventory cannot repair a fixed-price minimum. Explicit cancellation
        // is the permitted terminal path for these unchanged terms.
        assertCancellation(terms);
        assertFailure(OPERATOR, id, terms, abi.encodeWithSelector(Settlement.OrderCancelled.selector, id), true);
        assertReplay(terms, false);
    }

    function testInventoryFailureAfterPaymentRollsBackAndRetrySucceedsOnce() public {
        fixture(CASH, SHARES - 1, CASH);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertFailure(
            OPERATOR,
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(MockERC20.InsufficientBalance.selector),
            true
        );
        // Restore only the one missing YES unit; payment and allowance were rolled back.
        yes.mint(address(venue), 1);
        assertFill(terms);
        assertReplay(terms, true);
        assertReplay(terms, false);
    }

    function testExecutionFailureCanCancelAndBlockRetryAfterResourceRestored() public {
        fixture(CASH, SHARES - 1, CASH);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assertFailure(OPERATOR, id, terms, abi.encodeWithSelector(MockERC20.InsufficientBalance.selector), true);
        assertCancellation(terms);
        yes.mint(address(venue), 1);
        assertFailure(OPERATOR, id, terms, abi.encodeWithSelector(Settlement.OrderCancelled.selector, id), true);
    }

    function testUnsolicitedCustodyIsPreservedAndExcludedFromAccounting() public {
        usd.mint(STRANGER, 1_000);
        yes.mint(STRANGER, 2_000);
        VM.prank(STRANGER);
        assert(usd.transfer(address(settlement), 1_000));
        VM.prank(STRANGER);
        assert(yes.transfer(address(settlement), 2_000));
        assertFill(defaultTerms());
        assert(usd.balanceOf(address(settlement)) == 1_000);
        assert(yes.balanceOf(address(settlement)) == SHARES + 2_000);
        assert(settlement.totalCashSpent() == CASH && settlement.totalSharesPurchased() == SHARES);
    }

    function testMaximumCashAndLastUsableNonceWorkNextAmountRejects() public {
        fixture(MAX_CASH, type(uint64).max - 1, MAX_CASH);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.identity.nonce = type(uint64).max - 1;
        terms.cashAmount = MAX_CASH + 1;
        terms.minimumShares = type(uint64).max - 1;
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assertFailure(
            OPERATOR, id, terms, abi.encodeWithSelector(Settlement.InvalidCashAmount.selector, MAX_CASH + 1), true
        );
        terms.cashAmount = MAX_CASH;
        assertFill(terms);
        assert(settlement.totalCashSpent() == MAX_CASH);
        assert(settlement.totalSharesPurchased() == type(uint64).max - 1);
        assertReplay(terms, true);
    }

    function testWrongVenueReturnRollsBackVerifiedPaymentAndDelivery() public {
        adversarialVenueFailure(1, Settlement.InvalidFill.selector);
    }

    function testShortVenueDeliveryCannotCountExistingCustodyAsOutput() public {
        adversarialVenueFailure(2, Settlement.InvalidFill.selector);
    }

    function testVenueMustConsumeExactlyThisPurchaseCash() public {
        adversarialVenueFailure(3, Settlement.InvalidCashBalance.selector);
    }

    function testSettlementEnforcesMinimumEvenIfAdversarialVenueIgnoresIt() public {
        adversarialVenueFailure(4, Settlement.InvalidFill.selector);
    }

    function testConfiguredOperatorCannotReenterExecuteOrEitherCancel() public {
        ExecutionVenueDouble double = adversarialFixture(5);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        double.arm(terms);
        assertFill(terms);
        bytes32 expected = keccak256(abi.encodeWithSelector(Settlement.ReentrantCall.selector));
        assert(double.executeError() == expected && double.cancelError() == expected);
        assert(double.outerCancelError() == expected && double.purchases() == 1);
        ++terms.identity.nonce;
        assertUnseen(ProtocolEncoding.orderId(terms.identity));
        assert(settlement.totalCashSpent() == CASH && settlement.totalSharesPurchased() == SHARES);
        assertReplay(defaultTerms(), true);
        assertReplay(defaultTerms(), false);
        assert(double.purchases() == 1);
    }

    function testReentrantOuterFailureRollsBackPaymentAndGuardCanBeUsedAgain() public {
        ExecutionVenueDouble double = adversarialFixture(6);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        double.arm(terms);
        assertFailure(
            address(double),
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(Settlement.ReentrantCall.selector),
            true
        );
        assert(double.purchases() == 0 && double.executeError() == bytes32(0));
        assertCancellation(terms);
    }

    function testFalseExecutorPullIsRejected() public {
        cashDoubleFailure(ExecutionCashDouble.Mode.FalsePull, Settlement.TokenTransferFailed.selector);
    }

    function testFalseVenueApprovalRollsBackExecutorDebit() public {
        cashDoubleFailure(ExecutionCashDouble.Mode.FalseApprove, Settlement.TokenApprovalFailed.selector);
    }

    function testFalseApprovalResetRollsBackCompletedPurchase() public {
        cashDoubleFailure(ExecutionCashDouble.Mode.FalseReset, Settlement.TokenApprovalFailed.selector);
    }

    function testSuccessfulResetReturnMustActuallyLeaveZeroAllowance() public {
        cashDoubleFailure(ExecutionCashDouble.Mode.LyingReset, Settlement.InvalidVenueAllowance.selector);
    }

    function testShortExecutorPullCannotUseExistingCustodyCash() public {
        cashDoubleFailure(ExecutionCashDouble.Mode.ShortPull, Settlement.InvalidCashBalance.selector);
    }

    function testFuzzFullFillReplayAndCancellation(uint64 rawCash, uint64 rawMinimum, uint64 rawNonce) public {
        uint64 cash = rawCash % MAX_CASH + 1;
        uint64 output = cash * 2;
        fixture(cash, output, uint256(cash) + 1);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.cashAmount = cash;
        terms.minimumShares = rawMinimum % output + 1;
        terms.identity.nonce = rawNonce % type(uint64).max;
        assertFill(terms);
        assert(usd.allowance(EXECUTOR, address(settlement)) == 1);
        assertReplay(terms, true);
        assertReplay(terms, false);
    }

    function testFuzzInventoryFailureRollsBackThenRetry(uint64 rawCash, uint64 rawInventory) public {
        uint64 cash = rawCash % MAX_CASH + 1;
        uint64 output = cash * 2;
        uint64 inventory = rawInventory % output;
        fixture(cash, inventory, cash);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.cashAmount = cash;
        terms.minimumShares = output;
        assertFailure(
            OPERATOR,
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(MockERC20.InsufficientBalance.selector),
            true
        );
        yes.mint(address(venue), output - inventory);
        assertFill(terms);
        assertReplay(terms, true);
    }

    function fixture(uint64 cash, uint64 inventory, uint256 approved) private {
        usd = new MockERC20("Mock USD", "mUSD", address(this));
        yes = new MockERC20("Mock YES", "mYES", address(this));
        venue = new MockVenue(address(usd), address(yes), MARKET);
        settlement = new Settlement(configuration(OPERATOR));
        usd.mint(EXECUTOR, cash);
        yes.mint(address(venue), inventory);
        VM.prank(EXECUTOR);
        assert(usd.approve(address(settlement), approved));
    }

    function configuration(address operator_) private view returns (Settlement.Configuration memory) {
        return Settlement.Configuration(
            SOURCE, DESTINATION, PROGRAM, operator_, EXECUTOR, address(usd), address(yes), address(venue), MARKET
        );
    }

    function defaultTerms() private view returns (ProtocolEncoding.Terms memory) {
        return ProtocolEncoding.Terms(ProtocolEncoding.Identity(settlement.domain(), USER, 7), MARKET, 0, CASH, SHARES);
    }

    function allowanceFailureAndRetry(uint256 deficient) private {
        VM.prank(EXECUTOR);
        assert(usd.approve(address(settlement), deficient));
        ProtocolEncoding.Terms memory terms = defaultTerms();
        assertFailure(
            OPERATOR,
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector),
            true
        );
        VM.prank(EXECUTOR);
        assert(usd.approve(address(settlement), CASH));
        assertFill(terms);
        assertReplay(terms, true);
    }

    function assertFill(ProtocolEncoding.Terms memory terms) private {
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assertUnseen(id);
        Ledger memory expectedLedger = snapshot();
        uint64 quantity = terms.cashAmount * 2;
        expectedLedger.executorCash -= terms.cashAmount;
        expectedLedger.venueCash += terms.cashAmount;
        expectedLedger.custodyYes += quantity;
        expectedLedger.venueYes -= quantity;
        if (settlement.operator() == address(venue)) {
            expectedLedger.operatorCash += terms.cashAmount;
            expectedLedger.operatorYes -= quantity;
        }
        expectedLedger.executorAllowance -= terms.cashAmount;
        expectedLedger.venueAllowance = 0;
        expectedLedger.cashSpent += uint128(terms.cashAmount);
        expectedLedger.sharesPurchased += uint128(quantity);
        ProtocolEncoding.Receipt memory expected =
            ProtocolEncoding.Receipt(ProtocolEncoding.termsHash(terms), 1, quantity);
        VM.recordLogs();
        VM.prank(settlement.operator());
        ProtocolEncoding.Receipt memory actual = settlement.execute(id, terms);
        assert(keccak256(abi.encode(actual)) == keccak256(abi.encode(expected)));
        assert(keccak256(abi.encode(snapshot())) == keccak256(abi.encode(expectedLedger)));
        assertRecord(id, terms, expected);
        ExecutionTestVm.Log[] memory logs = VM.getRecordedLogs();
        assertTerminalEvent(logs, id, expected);
        uint256 approvals;
        uint256 purchases;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(usd) && logs[i].topics[0] == keccak256("Approval(address,address,uint256)")
                    && logs[i].topics[1] == bytes32(uint256(uint160(address(settlement))))
            ) {
                assert(logs[i].topics[2] == bytes32(uint256(uint160(address(venue)))));
                uint256 amount = abi.decode(logs[i].data, (uint256));
                assert(amount == (approvals == 0 ? terms.cashAmount : 0));
                ++approvals;
            }
            if (
                logs[i].emitter == address(venue)
                    && logs[i].topics[0] == keccak256("Purchased(address,bytes32,uint64,uint64)")
            ) {
                assert(logs[i].topics[1] == bytes32(uint256(uint160(address(settlement)))));
                assert(logs[i].topics[2] == terms.market);
                assert(keccak256(logs[i].data) == keccak256(abi.encode(terms.cashAmount, quantity)));
                ++purchases;
            }
        }
        // Plain MockVenue consumes the exact allowance, then settlement clears it.
        assert(approvals == 3);
        if (settlement.operator() == OPERATOR) assert(purchases == 1);
        assert(yes.allowance(address(settlement), address(venue)) == 0);
        assert(yes.allowance(address(settlement), EXECUTOR) == 0);
    }

    function assertCancellation(ProtocolEncoding.Terms memory terms) private {
        bytes32 before = economicDigest();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        assertUnseen(id);
        ProtocolEncoding.Receipt memory expected = ProtocolEncoding.Receipt(ProtocolEncoding.termsHash(terms), 2, 0);
        VM.recordLogs();
        VM.prank(settlement.operator());
        ProtocolEncoding.Receipt memory actual = settlement.cancel(id, terms);
        assert(keccak256(abi.encode(actual)) == keccak256(abi.encode(expected)));
        assertRecord(id, terms, expected);
        ExecutionTestVm.Log[] memory logs = VM.getRecordedLogs();
        assert(logs.length == 1);
        assertTerminalEvent(logs, id, expected);
        assert(economicDigest() == before);
    }

    function assertReplay(ProtocolEncoding.Terms memory terms, bool execute_) private {
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        bytes32 before = economicDigest();
        bytes32 beforeRecord = recordDigest(id);
        Settlement.OrderRecord memory record = settlement.orderRecord(id);
        VM.recordLogs();
        VM.prank(settlement.operator());
        ProtocolEncoding.Receipt memory receipt =
            execute_ ? settlement.execute(id, terms) : settlement.cancel(id, terms);
        assert(VM.getRecordedLogs().length == 0);
        assert(receipt.termsHash == record.termsHash && receipt.terminal == uint8(record.status));
        assert(
            receipt.filledQuantity == record.filledQuantity
                && ProtocolEncoding.receiptHash(receipt) == record.receiptHash
        );
        assert(recordDigest(id) == beforeRecord && economicDigest() == before);
    }

    function assertFailure(
        address caller,
        bytes32 id,
        ProtocolEncoding.Terms memory terms,
        bytes memory expected,
        bool execute_
    ) private {
        bytes32 before = economicDigest();
        bytes32 beforeRecord = recordDigest(id);
        VM.recordLogs();
        VM.prank(caller);
        (bool success, bytes memory reason) = address(settlement)
            .call(
                execute_
                    ? abi.encodeCall(settlement.execute, (id, terms))
                    : abi.encodeCall(settlement.cancel, (id, terms))
            );
        assert(!success && keccak256(reason) == keccak256(expected));
        assert(economicDigest() == before && recordDigest(id) == beforeRecord);
        // Foundry may record transient token logs inside a reverted call. No
        // terminal event can be emitted before the purchase is fully verified.
        assertNoTerminalEvent(VM.getRecordedLogs());
        if (settlement.orderRecord(id).status == Settlement.State.Unseen) assertUnseen(id);
    }

    function assertUnseen(bytes32 id) private view {
        Settlement.OrderRecord memory empty;
        assert(keccak256(abi.encode(settlement.orderRecord(id))) == keccak256(abi.encode(empty)));
    }

    function assertRecord(bytes32 id, ProtocolEncoding.Terms memory terms, ProtocolEncoding.Receipt memory receipt)
        private
        view
    {
        Settlement.OrderRecord memory record = settlement.orderRecord(id);
        assert(keccak256(abi.encode(record.terms)) == keccak256(abi.encode(terms)));
        assert(record.termsHash == receipt.termsHash && uint8(record.status) == receipt.terminal);
        assert(
            record.filledQuantity == receipt.filledQuantity
                && record.receiptHash == ProtocolEncoding.receiptHash(receipt)
        );
    }

    function assertTerminalEvent(ExecutionTestVm.Log[] memory logs, bytes32 id, ProtocolEncoding.Receipt memory receipt)
        private
        view
    {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(settlement) || logs[i].topics[0] != TERMINAL_EVENT) continue;
            ++count;
            assert(logs[i].topics.length == 3 && logs[i].topics[1] == id && logs[i].topics[2] == receipt.termsHash);
            assert(
                keccak256(logs[i].data)
                    == keccak256(
                        abi.encode(receipt.terminal, receipt.filledQuantity, ProtocolEncoding.receiptHash(receipt))
                    )
            );
        }
        assert(count == 1);
    }

    function assertNoTerminalEvent(ExecutionTestVm.Log[] memory logs) private view {
        for (uint256 i; i < logs.length; ++i) {
            assert(logs[i].emitter != address(settlement) || logs[i].topics[0] != TERMINAL_EVENT);
        }
    }

    function recordDigest(bytes32 id) private view returns (bytes32) {
        return keccak256(abi.encode(settlement.orderRecord(id)));
    }

    function snapshot() private view returns (Ledger memory) {
        return Ledger({
            executorCash: usd.balanceOf(EXECUTOR),
            operatorCash: usd.balanceOf(settlement.operator()),
            venueCash: usd.balanceOf(address(venue)),
            custodyCash: usd.balanceOf(address(settlement)),
            executorYes: yes.balanceOf(EXECUTOR),
            operatorYes: yes.balanceOf(settlement.operator()),
            venueYes: yes.balanceOf(address(venue)),
            custodyYes: yes.balanceOf(address(settlement)),
            executorAllowance: usd.allowance(EXECUTOR, address(settlement)),
            venueAllowance: usd.allowance(address(settlement), address(venue)),
            cashSupply: usd.totalSupply(),
            yesSupply: yes.totalSupply(),
            cashSpent: settlement.totalCashSpent(),
            sharesPurchased: settlement.totalSharesPurchased()
        });
    }

    /// @dev Include supplies, all fixture balances, all pairwise allowances, and totals.
    function economicDigest() private view returns (bytes32) {
        address[7] memory actors =
            [EXECUTOR, settlement.operator(), STRANGER, address(settlement), address(venue), address(this), address(0)];
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
        return keccak256(
            abi.encode(supplies, balances, allowances, settlement.totalCashSpent(), settlement.totalSharesPurchased())
        );
    }

    function adversarialFixture(uint256 mode) private returns (ExecutionVenueDouble double) {
        double = new ExecutionVenueDouble(usd, yes, MARKET, mode);
        venue = MockVenue(address(double));
        settlement = new Settlement(configuration(address(double)));
        yes.mint(address(double), SHARES);
        VM.prank(EXECUTOR);
        assert(usd.approve(address(settlement), CASH));
    }

    function adversarialVenueFailure(uint256 mode, bytes4 errorSelector) private {
        ExecutionVenueDouble double = adversarialFixture(mode);
        usd.mint(address(settlement), 1_000);
        yes.mint(address(settlement), 2_000);
        ProtocolEncoding.Terms memory terms = defaultTerms();
        if (mode == 4) terms.minimumShares = SHARES + 1;
        assertFailure(
            address(double),
            ProtocolEncoding.orderId(terms.identity),
            terms,
            abi.encodeWithSelector(errorSelector),
            true
        );
        assert(double.purchases() == 0);
    }

    function cashDoubleFailure(ExecutionCashDouble.Mode mode, bytes4 errorSelector) private {
        ExecutionCashDouble cash = new ExecutionCashDouble(mode, EXECUTOR);
        MockVenue targetVenue = new MockVenue(address(cash), address(yes), MARKET);
        Settlement.Configuration memory config = configuration(OPERATOR);
        config.usdToken = address(cash);
        config.venue = address(targetVenue);
        Settlement target = new Settlement(config);
        cash.mint(EXECUTOR, CASH);
        cash.mint(address(target), 1_000);
        yes.mint(address(targetVenue), SHARES);
        VM.prank(EXECUTOR);
        assert(cash.approve(address(target), CASH));
        ProtocolEncoding.Terms memory terms = defaultTerms();
        terms.identity.domain = target.domain();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        uint256 inventory = yes.balanceOf(address(targetVenue));
        uint256 supply = yes.totalSupply();
        VM.recordLogs();
        VM.prank(OPERATOR);
        (bool success, bytes memory reason) = address(target).call(abi.encodeCall(target.execute, (id, terms)));
        bytes memory expected = errorSelector == Settlement.TokenTransferFailed.selector
            || errorSelector == Settlement.TokenApprovalFailed.selector
            ? abi.encodeWithSelector(errorSelector, address(cash))
            : abi.encodeWithSelector(errorSelector);
        assert(!success && keccak256(reason) == keccak256(expected));
        assert(cash.balanceOf(EXECUTOR) == CASH && cash.balanceOf(address(target)) == 1_000);
        assert(cash.balanceOf(address(targetVenue)) == 0 && cash.allowance(address(target), address(targetVenue)) == 0);
        assert(cash.allowance(EXECUTOR, address(target)) == CASH);
        assert(
            yes.balanceOf(address(targetVenue)) == inventory && yes.balanceOf(address(target)) == 0
                && yes.totalSupply() == supply
        );
        assert(target.totalCashSpent() == 0 && target.totalSharesPurchased() == 0);
        Settlement.OrderRecord memory empty;
        assert(keccak256(abi.encode(target.orderRecord(id))) == keccak256(abi.encode(empty)));
        ExecutionTestVm.Log[] memory logs = VM.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assert(logs[i].emitter != address(target));
        }
    }
}
