// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockERC20} from "../src/mocks/MockERC20.sol";

interface TokenTestVm {
    function prank(address caller) external;
    function expectRevert(bytes calldata reason) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

/// @dev Dependency-free tests using distinct owners, spender, and fixture authority.
contract MockERC20Test {
    TokenTestVm private constant VM = TokenTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant SPENDER = address(0xCA11);
    address private constant STRANGER = address(0xBAD);
    MockERC20 private token;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setUp() public {
        token = new MockERC20("Mock USD", "mUSD", address(this));
    }

    function testMetadataInitialSupplyAndAuthorizedMint() public {
        assert(keccak256(bytes(token.name())) == keccak256("Mock USD"));
        assert(keccak256(bytes(token.symbol())) == keccak256("mUSD"));
        assert(token.decimals() == 6);
        assert(token.mintAuthority() == address(this));
        assertLedger(0, 0, 0, 0);
        VM.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(0), ALICE, 10_000_000);
        token.mint(ALICE, 10_000_000);
        assertLedger(10_000_000, 0, 10_000_000, 0);
        MockERC20 yes = new MockERC20("Mock YES", "mYES", ALICE);
        assert(keccak256(bytes(yes.name())) == keccak256("Mock YES"));
        assert(keccak256(bytes(yes.symbol())) == keccak256("mYES"));
        assert(yes.decimals() == 6 && yes.totalSupply() == 0);
        assert(yes.mintAuthority() == ALICE);
        VM.prank(ALICE);
        yes.mint(BOB, 20_000_000);
        assert(yes.balanceOf(BOB) == 20_000_000 && yes.totalSupply() == 20_000_000);
    }

    function testRejectZeroMintAuthority() public {
        VM.expectRevert(abi.encodeWithSelector(MockERC20.InvalidAddress.selector));
        new MockERC20("Mock USD", "mUSD", address(0));
    }

    function testRejectUnauthorizedMintAndZeroRecipient() public {
        token.mint(ALICE, 100);
        assertRevert(STRANGER, abi.encodeCall(token.mint, (BOB, 1)), MockERC20.UnauthorizedMint.selector);
        assertLedger(100, 0, 100, 0);
        assertRevert(address(this), abi.encodeCall(token.mint, (address(0), 1)), MockERC20.InvalidAddress.selector);
        assert(token.balanceOf(address(0)) == 0);
        assertLedger(100, 0, 100, 0);
    }

    function testSupplyCapAndOverflowRollback() public {
        uint256 cap = type(uint64).max;
        token.mint(ALICE, cap - 1);
        token.mint(BOB, 1);
        assertLedger(cap - 1, 1, cap, 0);
        assertRevert(address(this), abi.encodeCall(token.mint, (BOB, 1)), MockERC20.SupplyCapExceeded.selector);
        assertLedger(cap - 1, 1, cap, 0);
        assertRevert(
            address(this), abi.encodeCall(token.mint, (ALICE, type(uint256).max)), MockERC20.SupplyCapExceeded.selector
        );
        assertLedger(cap - 1, 1, cap, 0);
        token.mint(BOB, 0);
        VM.prank(ALICE);
        assert(token.transfer(BOB, cap - 1));
        assertLedger(0, cap, cap, 0);
    }

    function testRejectSingleMintAboveCapacity() public {
        assertRevert(
            address(this),
            abi.encodeCall(token.mint, (ALICE, uint256(type(uint64).max) + 1)),
            MockERC20.SupplyCapExceeded.selector
        );
        assertLedger(0, 0, 0, 0);
    }

    function testTransferApprovalAndFiniteAllowanceConsumption() public {
        token.mint(ALICE, 100);
        VM.expectEmit(true, true, false, true, address(token));
        emit Transfer(ALICE, BOB, 20);
        VM.prank(ALICE);
        assert(token.transfer(BOB, 20));
        assertLedger(80, 20, 100, 0);
        VM.expectEmit(true, true, false, true, address(token));
        emit Approval(ALICE, SPENDER, 50);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 50));
        assertLedger(80, 20, 100, 50);
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, BOB, 30));
        assertLedger(50, 50, 100, 20);
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, BOB, 20));
        assertLedger(30, 70, 100, 0);
        VM.prank(BOB);
        assert(token.transfer(ALICE, 10));
        assertLedger(40, 60, 100, 0);
    }

    function testApprovalReplacementAndRevocation() public {
        token.mint(ALICE, 100);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 70));
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 25));
        assertLedger(100, 0, 100, 25);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 0));
        assertRevert(
            SPENDER, abi.encodeCall(token.transferFrom, (ALICE, BOB, 1)), MockERC20.InsufficientAllowance.selector
        );
        assertLedger(100, 0, 100, 0);
    }

    function testMaximumAllowanceIsNotConsumed() public {
        token.mint(ALICE, 100);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, type(uint256).max));
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, BOB, 37));
        assertLedger(63, 37, 100, type(uint256).max);
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, BOB, 63));
        assertLedger(0, 100, 100, type(uint256).max);
        assertRevert(
            SPENDER, abi.encodeCall(token.transferFrom, (ALICE, BOB, 1)), MockERC20.InsufficientBalance.selector
        );
        assertLedger(0, 100, 100, type(uint256).max);
    }

    function testInsufficientBalanceAndAllowanceRollback() public {
        token.mint(ALICE, 100);
        assertRevert(ALICE, abi.encodeCall(token.transfer, (BOB, 101)), MockERC20.InsufficientBalance.selector);
        assertLedger(100, 0, 100, 0);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 50));
        assertRevert(
            SPENDER, abi.encodeCall(token.transferFrom, (ALICE, BOB, 51)), MockERC20.InsufficientAllowance.selector
        );
        assertLedger(100, 0, 100, 50);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 101));
        // Allowance is consumed internally before the balance check fails.
        assertRevert(
            SPENDER, abi.encodeCall(token.transferFrom, (ALICE, BOB, 101)), MockERC20.InsufficientBalance.selector
        );
        assertLedger(100, 0, 100, 101);
    }

    function testUnauthorizedTransferFromIncludingOwnerRequiresAllowance() public {
        token.mint(ALICE, 100);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 40));
        assertRevert(
            STRANGER, abi.encodeCall(token.transferFrom, (ALICE, BOB, 1)), MockERC20.InsufficientAllowance.selector
        );
        assertLedger(100, 0, 100, 40);
        assert(token.allowance(ALICE, STRANGER) == 0);
        assertRevert(
            ALICE, abi.encodeCall(token.transferFrom, (ALICE, BOB, 1)), MockERC20.InsufficientAllowance.selector
        );
        assertLedger(100, 0, 100, 40);
        assert(token.allowance(ALICE, ALICE) == 0);
    }

    function testZeroTransferRecipientsRollback() public {
        token.mint(ALICE, 100);
        assertRevert(ALICE, abi.encodeCall(token.transfer, (address(0), 1)), MockERC20.InvalidAddress.selector);
        assertRevert(ALICE, abi.encodeCall(token.transfer, (address(0), 0)), MockERC20.InvalidAddress.selector);
        assertLedger(100, 0, 100, 0);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 40));
        assertRevert(
            SPENDER, abi.encodeCall(token.transferFrom, (ALICE, address(0), 20)), MockERC20.InvalidAddress.selector
        );
        assert(token.balanceOf(address(0)) == 0);
        assertLedger(100, 0, 100, 40);
    }

    function testSelfAndZeroTransfersConserveBalances() public {
        token.mint(ALICE, 100);
        VM.prank(ALICE);
        assert(token.transfer(ALICE, 100));
        VM.prank(ALICE);
        assert(token.transfer(BOB, 0));
        assertLedger(100, 0, 100, 0);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, 40));
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, ALICE, 30));
        assertLedger(100, 0, 100, 10);
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, BOB, 0));
        assertLedger(100, 0, 100, 10);
    }

    function testFuzzTransferAndAllowanceConservation(uint64 supply, uint64 requested, uint64 extraAllowance) public {
        uint256 amount = uint256(requested) % (uint256(supply) + 1);
        uint256 approved = amount + extraAllowance;
        token.mint(ALICE, supply);
        VM.prank(ALICE);
        assert(token.approve(SPENDER, approved));
        assertLedger(supply, 0, supply, approved);
        VM.prank(SPENDER);
        assert(token.transferFrom(ALICE, BOB, amount));
        assertLedger(supply - amount, amount, supply, extraAllowance);
        VM.prank(BOB);
        assert(token.transfer(ALICE, amount));
        assertLedger(supply, 0, supply, extraAllowance);
    }

    function assertRevert(address caller, bytes memory data, bytes4 selector) private {
        VM.prank(caller);
        (bool success, bytes memory reason) = address(token).call(data);
        assert(!success);
        assert(keccak256(reason) == keccak256(abi.encodeWithSelector(selector)));
    }

    function assertLedger(uint256 alice, uint256 bob, uint256 supply, uint256 approved) private view {
        assert(token.balanceOf(ALICE) == alice);
        assert(token.balanceOf(BOB) == bob);
        assert(token.balanceOf(SPENDER) == 0 && token.balanceOf(STRANGER) == 0);
        assert(token.totalSupply() == supply && alice + bob == supply);
        assert(token.allowance(ALICE, SPENDER) == approved);
    }
}
