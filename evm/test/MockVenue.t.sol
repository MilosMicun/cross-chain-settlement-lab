// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";

interface VenueTestVm {
    function prank(address caller) external;
    function expectRevert(bytes calldata reason) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

/// @dev Test-only token double for invalid decimals and explicit false returns.
contract VenueTokenStub {
    uint8 private immutable DECIMALS;

    constructor(uint8 decimals_) {
        DECIMALS = decimals_;
    }

    function decimals() external view returns (uint8) {
        return DECIMALS;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract MockVenueTest {
    VenueTestVm private constant VM = VenueTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BUYER = address(0xA11CE);
    bytes32 private constant MARKET = 0x6666666666666666666666666666666666666666666666666666666666666666;
    uint64 private constant CASH = 10_000_000;
    uint64 private constant SHARES = 20_000_000;
    uint64 private constant MAX_CASH = type(uint64).max / 2;
    MockERC20 private usd;
    MockERC20 private yes;
    MockVenue private venue;

    struct Ledger {
        uint256 buyerCash;
        uint256 venueCash;
        uint256 buyerYes;
        uint256 venueYes;
        uint256 allowance;
        uint256 cashSupply;
        uint256 yesSupply;
    }

    event Purchased(address indexed buyer, bytes32 indexed market, uint64 cashAmount, uint64 filledQuantity);

    function setUp() public {
        (usd, yes, venue) = fixture(3 * CASH, 3 * SHARES, CASH);
    }

    function testImmutableConfiguration() public view {
        assert(address(venue.usdToken()) == address(usd));
        assert(address(venue.yesToken()) == address(yes));
        assert(venue.market() == MARKET);
        assert(usd.decimals() == 6 && yes.decimals() == 6);
    }

    function testRejectZeroOrIdenticalTokens() public {
        bytes memory reason = abi.encodeWithSelector(MockVenue.InvalidTokens.selector);
        VM.expectRevert(reason);
        new MockVenue(address(0), address(yes), MARKET);
        VM.expectRevert(reason);
        new MockVenue(address(usd), address(0), MARKET);
        VM.expectRevert(reason);
        new MockVenue(address(0), address(0), MARKET);
        VM.expectRevert(reason);
        new MockVenue(address(usd), address(usd), MARKET);
    }

    function testRejectZeroMarket() public {
        VM.expectRevert(abi.encodeWithSelector(MockVenue.InvalidMarket.selector, bytes32(0)));
        new MockVenue(address(usd), address(yes), bytes32(0));
    }

    function testRejectWrongDecimalsForEitherToken() public {
        VenueTokenStub wrong = new VenueTokenStub(18);
        VM.expectRevert(abi.encodeWithSelector(MockVenue.InvalidDecimals.selector));
        new MockVenue(address(wrong), address(yes), MARKET);
        VM.expectRevert(abi.encodeWithSelector(MockVenue.InvalidDecimals.selector));
        new MockVenue(address(usd), address(wrong), MARKET);
    }

    function testPurchaseExactMinimumBalancesSuppliesAndEvent() public {
        Ledger memory before = snapshot(usd, yes, venue);
        assert(before.buyerCash == 30_000_000 && before.venueCash == 0);
        assert(before.buyerYes == 0 && before.venueYes == 60_000_000);
        assert(before.allowance == CASH);
        VM.expectEmit(true, true, false, true, address(venue));
        emit Purchased(BUYER, MARKET, CASH, SHARES);
        VM.prank(BUYER);
        assert(venue.buy(MARKET, 0, CASH, SHARES) == SHARES);
        assertFill(snapshot(usd, yes, venue), before, CASH, SHARES);
        assert(usd.balanceOf(BUYER) == 20_000_000 && usd.balanceOf(address(venue)) == 10_000_000);
        assert(yes.balanceOf(BUYER) == 20_000_000 && yes.balanceOf(address(venue)) == 40_000_000);
        assert(usd.balanceOf(address(this)) == 0 && yes.balanceOf(address(this)) == 0);
    }

    function testMinimumBelowOutputStillDeliversFullFill() public {
        Ledger memory before = snapshot(usd, yes, venue);
        VM.prank(BUYER);
        assert(venue.buy(MARKET, 0, CASH, 1) == SHARES);
        assertFill(snapshot(usd, yes, venue), before, CASH, SHARES);
    }

    function testUnattainableMinimumRevertsWithoutChanges() public {
        assertFailure(
            MARKET, 0, CASH, SHARES + 1, abi.encodeWithSelector(MockVenue.MinimumNotMet.selector, SHARES, SHARES + 1)
        );
        assertFailure(
            MARKET,
            0,
            CASH,
            type(uint64).max,
            abi.encodeWithSelector(MockVenue.MinimumNotMet.selector, SHARES, type(uint64).max)
        );
    }

    function testWrongMarketAndOutcome() public {
        assertFailure(bytes32(0), 0, CASH, SHARES, abi.encodeWithSelector(MockVenue.InvalidMarket.selector, bytes32(0)));
        bytes32 other = bytes32(uint256(1));
        assertFailure(other, 0, CASH, SHARES, abi.encodeWithSelector(MockVenue.InvalidMarket.selector, other));
        assertFailure(MARKET, 1, CASH, SHARES, abi.encodeWithSelector(MockVenue.InvalidOutcome.selector, uint8(1)));
        assertFailure(MARKET, 255, CASH, SHARES, abi.encodeWithSelector(MockVenue.InvalidOutcome.selector, uint8(255)));
    }

    function testZeroAmountsAndAboveCashBound() public {
        assertFailure(MARKET, 0, 0, 1, abi.encodeWithSelector(MockVenue.InvalidCashAmount.selector, uint64(0)));
        assertFailure(MARKET, 0, CASH, 0, abi.encodeWithSelector(MockVenue.InvalidMinimumShares.selector));
        assertFailure(
            MARKET, 0, MAX_CASH + 1, 1, abi.encodeWithSelector(MockVenue.InvalidCashAmount.selector, MAX_CASH + 1)
        );
        assertFailure(
            MARKET,
            0,
            type(uint64).max,
            1,
            abi.encodeWithSelector(MockVenue.InvalidCashAmount.selector, type(uint64).max)
        );
    }

    function testMissingAndInsufficientAllowance() public {
        VM.prank(BUYER);
        assert(usd.approve(address(venue), 0));
        assertFailure(MARKET, 0, CASH, SHARES, abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector));
        VM.prank(BUYER);
        assert(usd.approve(address(venue), CASH - 1));
        assertFailure(MARKET, 0, CASH, SHARES, abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector));
    }

    function testInsufficientBuyerCashRollsBackAllowance() public {
        uint64 tooMuch = 3 * CASH + 1;
        VM.prank(BUYER);
        assert(usd.approve(address(venue), tooMuch));
        assertFailure(MARKET, 0, tooMuch, 1, abi.encodeWithSelector(MockERC20.InsufficientBalance.selector));
    }

    function testYesDeliveryFailureRollsBackSuccessfulPaymentAndAllowance() public {
        (MockERC20 cashToken, MockERC20 yesToken, MockVenue target) = fixture(CASH, SHARES - 1, CASH);
        Ledger memory before = snapshot(cashToken, yesToken, target);
        assert(before.buyerCash == CASH && before.venueCash == 0);
        assert(before.allowance == CASH && before.venueYes == SHARES - 1);
        // Cash transferFrom is fully funded and approved. The later YES transfer
        // fails with InsufficientBalance; the whole buy must undo the cash debit,
        // venue credit, and finite allowance consumption. A trace shows the order.
        assertBuyRevert(target, MARKET, 0, CASH, SHARES, abi.encodeWithSelector(MockERC20.InsufficientBalance.selector));
        assertUnchanged(snapshot(cashToken, yesToken, target), before);
        // Restore only the missing fixture inventory and retry the same purchase.
        yesToken.mint(address(target), 1);
        Ledger memory restored = snapshot(cashToken, yesToken, target);
        assert(restored.yesSupply == before.yesSupply + 1);
        VM.prank(BUYER);
        assert(target.buy(MARKET, 0, CASH, SHARES) == SHARES);
        assertFill(snapshot(cashToken, yesToken, target), restored, CASH, SHARES);
    }

    function testExplicitFalsePaymentResultIsRejected() public {
        VenueTokenStub falseCash = new VenueTokenStub(6);
        MockVenue target = new MockVenue(address(falseCash), address(yes), MARKET);
        yes.mint(address(target), SHARES);
        uint256 supply = yes.totalSupply();
        assertBuyRevert(
            target,
            MARKET,
            0,
            CASH,
            SHARES,
            abi.encodeWithSelector(MockVenue.TokenTransferFailed.selector, address(falseCash))
        );
        assert(yes.balanceOf(address(target)) == SHARES);
        assert(yes.balanceOf(BUYER) == 0 && yes.totalSupply() == supply);
    }

    function testExplicitFalseDeliveryResultRollsBackPayment() public {
        VenueTokenStub falseYes = new VenueTokenStub(6);
        MockVenue target = new MockVenue(address(usd), address(falseYes), MARKET);
        VM.prank(BUYER);
        assert(usd.approve(address(target), CASH));
        uint256 cashBalance = usd.balanceOf(BUYER);
        uint256 supply = usd.totalSupply();
        assertBuyRevert(
            target,
            MARKET,
            0,
            CASH,
            SHARES,
            abi.encodeWithSelector(MockVenue.TokenTransferFailed.selector, address(falseYes))
        );
        assert(usd.balanceOf(BUYER) == cashBalance && usd.balanceOf(address(target)) == 0);
        assert(usd.allowance(BUYER, address(target)) == CASH && usd.totalSupply() == supply);
    }

    function testValidCashBoundaryAndRejectedNextValue() public {
        uint64 output = type(uint64).max - 1;
        (MockERC20 cashToken, MockERC20 yesToken, MockVenue target) = fixture(MAX_CASH, output, MAX_CASH);
        Ledger memory before = snapshot(cashToken, yesToken, target);
        assertBuyRevert(
            target,
            MARKET,
            0,
            MAX_CASH + 1,
            1,
            abi.encodeWithSelector(MockVenue.InvalidCashAmount.selector, MAX_CASH + 1)
        );
        assertUnchanged(snapshot(cashToken, yesToken, target), before);
        VM.prank(BUYER);
        assert(target.buy(MARKET, 0, MAX_CASH, output) == output);
        assertFill(snapshot(cashToken, yesToken, target), before, MAX_CASH, output);
        assert(yesToken.balanceOf(BUYER) == type(uint64).max - 1);
    }

    function testFuzzFullFillAndConservation(uint64 rawCash, uint64 rawMinimum) public {
        uint64 amount = rawCash % MAX_CASH + 1;
        uint64 output = uint64(uint256(amount) * 2);
        uint64 minimum = rawMinimum % output + 1;
        (MockERC20 cashToken, MockERC20 yesToken, MockVenue target) = fixture(amount, output, uint256(amount) + 1);
        Ledger memory before = snapshot(cashToken, yesToken, target);
        VM.prank(BUYER);
        assert(target.buy(MARKET, 0, amount, minimum) == output);
        assertFill(snapshot(cashToken, yesToken, target), before, amount, output);
        assert(cashToken.allowance(BUYER, address(target)) == 1);
    }

    function testFuzzInsufficientInventoryRollsBack(uint64 rawCash, uint64 rawInventory) public {
        uint64 amount = rawCash % MAX_CASH + 1;
        uint64 output = uint64(uint256(amount) * 2);
        uint64 inventory = rawInventory % output;
        (MockERC20 cashToken, MockERC20 yesToken, MockVenue target) = fixture(amount, inventory, amount);
        Ledger memory before = snapshot(cashToken, yesToken, target);
        assertBuyRevert(
            target, MARKET, 0, amount, output, abi.encodeWithSelector(MockERC20.InsufficientBalance.selector)
        );
        assertUnchanged(snapshot(cashToken, yesToken, target), before);
    }

    function fixture(uint64 cashBalance, uint64 inventory, uint256 approved)
        private
        returns (MockERC20 cashToken, MockERC20 yesToken, MockVenue target)
    {
        cashToken = new MockERC20("Mock USD", "mUSD", address(this));
        yesToken = new MockERC20("Mock YES", "mYES", address(this));
        target = new MockVenue(address(cashToken), address(yesToken), MARKET);
        cashToken.mint(BUYER, cashBalance);
        yesToken.mint(address(target), inventory);
        VM.prank(BUYER);
        assert(cashToken.approve(address(target), approved));
    }

    function assertFailure(bytes32 market, uint8 outcome, uint64 cash, uint64 minimum, bytes memory expected) private {
        Ledger memory before = snapshot(usd, yes, venue);
        assertBuyRevert(venue, market, outcome, cash, minimum, expected);
        assertUnchanged(snapshot(usd, yes, venue), before);
    }

    function assertBuyRevert(
        MockVenue target,
        bytes32 market,
        uint8 outcome,
        uint64 cash,
        uint64 minimum,
        bytes memory expected
    ) private {
        VM.prank(BUYER);
        (bool success, bytes memory reason) =
            address(target).call(abi.encodeCall(target.buy, (market, outcome, cash, minimum)));
        assert(!success);
        assert(keccak256(reason) == keccak256(expected));
    }

    function snapshot(MockERC20 cashToken, MockERC20 yesToken, MockVenue target) private view returns (Ledger memory) {
        return Ledger({
            buyerCash: cashToken.balanceOf(BUYER),
            venueCash: cashToken.balanceOf(address(target)),
            buyerYes: yesToken.balanceOf(BUYER),
            venueYes: yesToken.balanceOf(address(target)),
            allowance: cashToken.allowance(BUYER, address(target)),
            cashSupply: cashToken.totalSupply(),
            yesSupply: yesToken.totalSupply()
        });
    }

    function assertUnchanged(Ledger memory after_, Ledger memory before) private pure {
        assert(keccak256(abi.encode(after_)) == keccak256(abi.encode(before)));
    }

    function assertFill(Ledger memory after_, Ledger memory before, uint64 cash, uint64 shares) private pure {
        assert(after_.buyerCash == before.buyerCash - cash);
        assert(after_.venueCash == before.venueCash + cash);
        assert(after_.buyerYes == before.buyerYes + shares);
        assert(after_.venueYes == before.venueYes - shares);
        assert(after_.allowance == before.allowance - cash);
        assert(after_.cashSupply == before.cashSupply && after_.yesSupply == before.yesSupply);
        assert(after_.buyerCash + after_.venueCash == before.buyerCash + before.venueCash);
        assert(after_.buyerYes + after_.venueYes == before.buyerYes + before.venueYes);
    }
}
