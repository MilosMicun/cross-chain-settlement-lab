// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Settlement} from "../../src/Settlement.sol";
import {ProtocolEncoding} from "../../src/ProtocolEncoding.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockVenue} from "../../src/mocks/MockVenue.sol";

interface HandlerVm {
    function prank(address caller) external;
}

/// @dev Bounded reference model. Only real token transfers/approvals change resources;
///      no storage injection, inventory withdrawal, minting action, or error swallowing.
contract SettlementHandler {
    HandlerVm private constant VM = HandlerVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0x0F);
    address private constant EXECUTOR = address(0xE);
    address private constant DONOR = address(0xD);
    address private constant BANK = address(0xB);
    bytes32 private constant MARKET = bytes32(uint256(0x66));
    uint256 private constant EXECUTOR_INITIAL = 4_000_000;
    uint256 private constant BANK_INITIAL = 100_000_000;
    uint256 private constant DONOR_INITIAL = 10_000_000;
    uint256 private constant CUSTODY_USD_INITIAL = 333;
    uint256 private constant CUSTODY_YES_INITIAL = 111;
    uint256 private constant VENUE_USD_INITIAL = 777;
    uint256 private constant FULL_ALLOWANCE = 50_000_000;
    uint256 private constant POOL_SIZE = 12;

    enum ExpectedState {
        Unseen,
        Filled,
        Cancelled
    }

    struct ModelOrder {
        ProtocolEncoding.Terms terms;
        bytes32 id;
        bytes32 termsHash;
        ExpectedState status;
    }

    struct Metrics {
        uint256 actions;
        uint256 settlementCalls;
        uint256 fills;
        uint256 cancellations;
        uint256 filledExecutionReplays;
        uint256 filledCancellationReplays;
        uint256 cancelledReplays;
        uint256 delayedExecutions;
        uint256 allowanceFailures;
        uint256 cashFailures;
        uint256 inventoryFailures;
        uint256 conflicts;
        uint256 restorations;
        uint256 failureThenFill;
        uint256 failureThenCancel;
        uint256 fundingTransfers;
        uint256 inventoryTransfers;
        uint256 usdDonations;
        uint256 yesDonations;
        uint256 skips;
    }

    MockERC20 public immutable USD;
    MockERC20 public immutable YES;
    MockVenue public immutable VENUE;
    Settlement public immutable SETTLEMENT;
    ProtocolEncoding.Domain private fixtureDomain;
    ModelOrder[12] private pool;
    Metrics private coverage;
    uint256 private filledCash;
    uint256 private filledShares;
    uint256 private funding;
    uint256 private replenishment;
    uint256 private donatedUsd;
    uint256 private donatedYes;
    uint256 private executorAllowance;

    constructor() {
        USD = new MockERC20("Mock USD", "mUSD", address(this));
        YES = new MockERC20("Mock YES", "mYES", address(this));
        VENUE = new MockVenue(address(USD), address(YES), MARKET);
        SETTLEMENT = new Settlement(
            Settlement.Configuration(
                bytes32(uint256(0x11)),
                bytes32(uint256(0x22)),
                bytes32(uint256(0x33)),
                OPERATOR,
                EXECUTOR,
                address(USD),
                address(YES),
                address(VENUE),
                MARKET
            )
        );
        // The model domain comes from fixture inputs, never from settlement getters.
        fixtureDomain = ProtocolEncoding.Domain(
            bytes32(uint256(0x11)), bytes32(uint256(0x22)), bytes32(uint256(0x33)), block.chainid, address(SETTLEMENT)
        );
        for (uint64 i; i < POOL_SIZE; ++i) {
            // Three source users, each with four distinct permanent nonces.
            ProtocolEncoding.Terms memory terms = ProtocolEncoding.Terms(
                ProtocolEncoding.Identity(fixtureDomain, bytes32(uint256(0x100 + i % 3)), i / 3),
                MARKET,
                0,
                1_000_000 + i * 1_000,
                2_000_000 + i * 2_000
            );
            pool[i] = ModelOrder({
                terms: terms,
                id: identityHash(terms.identity),
                termsHash: termsHash(terms),
                status: ExpectedState.Unseen
            });
        }
        USD.mint(EXECUTOR, EXECUTOR_INITIAL);
        USD.mint(BANK, BANK_INITIAL);
        USD.mint(DONOR, DONOR_INITIAL);
        USD.mint(address(VENUE), VENUE_USD_INITIAL);
        USD.mint(address(SETTLEMENT), CUSTODY_USD_INITIAL);
        YES.mint(BANK, BANK_INITIAL);
        YES.mint(DONOR, DONOR_INITIAL);
        YES.mint(address(SETTLEMENT), CUSTODY_YES_INITIAL);
        approveExecutor(FULL_ALLOWANCE);
        assertModel();
    }

    function metrics() external view returns (Metrics memory) {
        return coverage;
    }

    function execute(uint256 rawOrder) external {
        ++coverage.actions;
        executeOrder(rawOrder % POOL_SIZE);
    }

    function cancel(uint256 rawOrder) external {
        ++coverage.actions;
        cancelOrder(rawOrder % POOL_SIZE);
    }

    function race(uint256 rawOrder, bool executeFirst) external {
        ++coverage.actions;
        uint256 i = rawOrder % POOL_SIZE;
        if (executeFirst) {
            executeOrder(i);
            cancelOrder(i);
        } else {
            cancelOrder(i);
            executeOrder(i);
        }
    }

    function replay(uint256 rawOrder, bool execution) external {
        ++coverage.actions;
        uint256 i = rawOrder % POOL_SIZE;
        if (pool[i].status == ExpectedState.Unseen) {
            skip();
            return;
        }
        if (execution) executeOrder(i);
        else cancelOrder(i);
    }

    function conflict(uint256 rawOrder, bool changeCash, bool execution) external {
        ++coverage.actions;
        uint256 i = rawOrder % POOL_SIZE;
        if (pool[i].status == ExpectedState.Unseen) {
            skip();
            return;
        }
        ProtocolEncoding.Terms memory changed = pool[i].terms;
        if (changeCash) ++changed.cashAmount;
        else --changed.minimumShares;
        bytes memory expected = abi.encodeWithSelector(
            Settlement.TermsConflict.selector, pool[i].id, pool[i].termsHash, termsHash(changed)
        );
        callSettlement(i, changed, execution, expected, pool[i].status);
        ++coverage.conflicts;
    }

    function setAllowance(uint256 rawAmount) external {
        ++coverage.actions;
        uint256 amount = rawAmount % (FULL_ALLOWANCE + 1);
        if (amount == executorAllowance) skip();
        else approveExecutor(amount);
    }

    function fund(uint256 rawAmount) external {
        ++coverage.actions;
        uint256 amount = capped(rawAmount % 3_000_000 + 1, BANK_INITIAL - funding);
        if (amount == 0) skip();
        else fundExecutor(amount);
    }

    function replenish(uint256 rawAmount) external {
        ++coverage.actions;
        uint256 amount = capped(rawAmount % 4_000_000 + 1, BANK_INITIAL - replenishment);
        if (amount == 0) skip();
        else replenishVenue(amount);
    }

    function donate(uint256 rawAmount, bool shares) external {
        ++coverage.actions;
        uint256 remaining = DONOR_INITIAL - (shares ? donatedYes : donatedUsd);
        uint256 amount = capped(rawAmount % 10_000 + 1, remaining);
        if (amount == 0) {
            skip();
            return;
        }
        VM.prank(DONOR);
        if (shares) {
            assert(YES.transfer(address(SETTLEMENT), amount));
            donatedYes += amount;
            ++coverage.yesDonations;
        } else {
            assert(USD.transfer(address(SETTLEMENT), amount));
            donatedUsd += amount;
            ++coverage.usdDonations;
        }
        assertModel();
    }

    function restore(uint256 rawOrder) external {
        ++coverage.actions;
        (bool found, uint256 i) = unseen(rawOrder);
        if (!found || !restoreResources(i)) skip();
    }

    function failAllowance(uint256 rawOrder, bool cancelAfterFailure) external {
        ++coverage.actions;
        (bool found, uint256 i) = unseen(rawOrder);
        if (!found) {
            skip();
            return;
        }
        approveExecutor(pool[i].terms.cashAmount - 1);
        executeOrder(i);
        finishFailure(i, cancelAfterFailure);
    }

    function failInventory(uint256 rawOrder, bool cancelAfterFailure) external {
        ++coverage.actions;
        (bool found, uint256 i) = unseen(rawOrder);
        // Inventory cannot be withdrawn. Once sufficient, this branch is a real skip.
        if (!found || replenishment - filledShares >= uint256(pool[i].terms.cashAmount) * 2) {
            skip();
            return;
        }
        ensureCash(i);
        approveExecutor(FULL_ALLOWANCE);
        executeOrder(i);
        finishFailure(i, cancelAfterFailure);
    }

    function finishFailure(uint256 i, bool cancelAfterFailure) private {
        if (cancelAfterFailure) cancelOrder(i);
        assert(restoreResources(i));
        executeOrder(i);
        if (cancelAfterFailure) ++coverage.failureThenCancel;
        else ++coverage.failureThenFill;
    }

    function restoreResources(uint256 i) private returns (bool changed) {
        uint256 cash = pool[i].terms.cashAmount;
        if (EXECUTOR_INITIAL + funding - filledCash < cash) {
            ensureCash(i);
            changed = true;
        }
        uint256 quantity = cash * 2;
        uint256 inventory = replenishment - filledShares;
        if (inventory < quantity) {
            replenishVenue(quantity - inventory);
            changed = true;
        }
        if (executorAllowance < cash) {
            approveExecutor(FULL_ALLOWANCE);
            changed = true;
        }
        if (changed) ++coverage.restorations;
        assertModel();
    }

    function ensureCash(uint256 i) private {
        uint256 balance = EXECUTOR_INITIAL + funding - filledCash;
        if (balance < pool[i].terms.cashAmount) fundExecutor(pool[i].terms.cashAmount - balance);
    }

    function approveExecutor(uint256 amount) private {
        VM.prank(EXECUTOR);
        assert(USD.approve(address(SETTLEMENT), amount));
        executorAllowance = amount;
        assertModel();
    }

    function fundExecutor(uint256 amount) private {
        VM.prank(BANK);
        assert(USD.transfer(EXECUTOR, amount));
        funding += amount;
        ++coverage.fundingTransfers;
        assertModel();
    }

    function replenishVenue(uint256 amount) private {
        VM.prank(BANK);
        assert(YES.transfer(address(VENUE), amount));
        replenishment += amount;
        ++coverage.inventoryTransfers;
        assertModel();
    }

    function executeOrder(uint256 i) private {
        ModelOrder storage order = pool[i];
        bytes memory expectedError;
        ExpectedState expectedState = order.status;
        if (order.status == ExpectedState.Cancelled) {
            expectedError = abi.encodeWithSelector(Settlement.OrderCancelled.selector, order.id);
            ++coverage.delayedExecutions;
        } else if (order.status == ExpectedState.Filled) {
            ++coverage.filledExecutionReplays;
        } else if (executorAllowance < order.terms.cashAmount) {
            expectedError = abi.encodeWithSelector(MockERC20.InsufficientAllowance.selector);
            ++coverage.allowanceFailures;
        } else if (EXECUTOR_INITIAL + funding - filledCash < order.terms.cashAmount) {
            expectedError = abi.encodeWithSelector(MockERC20.InsufficientBalance.selector);
            ++coverage.cashFailures;
        } else if (replenishment - filledShares < uint256(order.terms.cashAmount) * 2) {
            expectedError = abi.encodeWithSelector(MockERC20.InsufficientBalance.selector);
            ++coverage.inventoryFailures;
        } else {
            expectedState = ExpectedState.Filled;
            ++coverage.fills;
        }
        callSettlement(i, order.terms, true, expectedError, expectedState);
    }

    function cancelOrder(uint256 i) private {
        ExpectedState expectedState = pool[i].status;
        if (expectedState == ExpectedState.Unseen) {
            expectedState = ExpectedState.Cancelled;
            ++coverage.cancellations;
        } else if (expectedState == ExpectedState.Filled) {
            ++coverage.filledCancellationReplays;
        } else {
            ++coverage.cancelledReplays;
        }
        callSettlement(i, pool[i].terms, false, bytes(""), expectedState);
    }

    /// @dev The complete expected result is chosen before the real call. A revert
    ///      leaves the model untouched; successes update it only from that prediction.
    function callSettlement(
        uint256 i,
        ProtocolEncoding.Terms memory supplied,
        bool execution,
        bytes memory expectedError,
        ExpectedState expectedState
    ) private {
        ++coverage.settlementCalls;
        ModelOrder storage order = pool[i];
        uint64 quantity = expectedState == ExpectedState.Filled ? order.terms.cashAmount * 2 : 0;
        bytes memory expectedReturn =
            abi.encode(ProtocolEncoding.Receipt(order.termsHash, uint8(expectedState), quantity));
        VM.prank(OPERATOR);
        (bool success, bytes memory result) = address(SETTLEMENT)
            .call(
                execution
                    ? abi.encodeCall(SETTLEMENT.execute, (order.id, supplied))
                    : abi.encodeCall(SETTLEMENT.cancel, (order.id, supplied))
            );
        if (expectedError.length != 0) {
            assert(!success && keccak256(result) == keccak256(expectedError));
        } else {
            assert(success && keccak256(result) == keccak256(expectedReturn));
            if (order.status == ExpectedState.Unseen) {
                assert(expectedState != ExpectedState.Unseen);
                order.status = expectedState;
                if (expectedState == ExpectedState.Filled) {
                    filledCash += order.terms.cashAmount;
                    filledShares += quantity;
                    executorAllowance -= order.terms.cashAmount;
                }
            }
        }
        // Also runs between every call in compound actions, including expected reverts.
        assertModel();
    }

    /// @notice All related properties use one shared generated execution sequence.
    function assertModel() public view {
        uint256 summedCash;
        uint256 summedShares;
        for (uint256 i; i < POOL_SIZE; ++i) {
            ModelOrder storage order = pool[i];
            Settlement.OrderRecord memory expected;
            if (order.status != ExpectedState.Unseen) {
                uint64 quantity = order.status == ExpectedState.Filled ? order.terms.cashAmount * 2 : 0;
                expected = Settlement.OrderRecord(
                    order.terms,
                    order.termsHash,
                    Settlement.State(uint8(order.status)),
                    quantity,
                    sha256(abi.encodePacked("CCSLRC01", order.termsHash, uint8(order.status), quantity))
                );
                if (order.status == ExpectedState.Filled) {
                    summedCash += order.terms.cashAmount;
                    summedShares += quantity;
                }
            }
            assert(keccak256(abi.encode(SETTLEMENT.orderRecord(order.id))) == keccak256(abi.encode(expected)));
        }
        Settlement.OrderRecord memory empty;
        assert(keccak256(abi.encode(SETTLEMENT.orderRecord(bytes32(0)))) == keccak256(abi.encode(empty)));
        assert(filledCash == summedCash && filledShares == summedShares);
        assert(SETTLEMENT.totalCashSpent() == filledCash && SETTLEMENT.totalSharesPurchased() == filledShares);

        address[8] memory actors =
            [EXECUTOR, OPERATOR, DONOR, BANK, address(VENUE), address(SETTLEMENT), address(this), address(0)];
        uint256[8] memory cashBalances = [
            EXECUTOR_INITIAL + funding - filledCash,
            0,
            DONOR_INITIAL - donatedUsd,
            BANK_INITIAL - funding,
            VENUE_USD_INITIAL + filledCash,
            CUSTODY_USD_INITIAL + donatedUsd,
            0,
            0
        ];
        uint256[8] memory shareBalances = [
            uint256(0),
            0,
            DONOR_INITIAL - donatedYes,
            BANK_INITIAL - replenishment,
            replenishment - filledShares,
            CUSTODY_YES_INITIAL + filledShares + donatedYes,
            0,
            0
        ];
        uint256 cashSum;
        uint256 shareSum;
        for (uint256 i; i < actors.length; ++i) {
            assert(USD.balanceOf(actors[i]) == cashBalances[i]);
            assert(YES.balanceOf(actors[i]) == shareBalances[i]);
            cashSum += USD.balanceOf(actors[i]);
            shareSum += YES.balanceOf(actors[i]);
            assert(YES.allowance(address(SETTLEMENT), actors[i]) == 0);
            if (actors[i] != address(SETTLEMENT)) assert(USD.allowance(EXECUTOR, actors[i]) == 0);
            assert(USD.allowance(address(SETTLEMENT), actors[i]) == 0);
        }
        assert(cashSum == EXECUTOR_INITIAL + BANK_INITIAL + DONOR_INITIAL + VENUE_USD_INITIAL + CUSTODY_USD_INITIAL);
        assert(shareSum == BANK_INITIAL + DONOR_INITIAL + CUSTODY_YES_INITIAL);
        assert(USD.totalSupply() == cashSum && YES.totalSupply() == shareSum);
        assert(USD.allowance(EXECUTOR, address(SETTLEMENT)) == executorAllowance);
    }

    function unseen(uint256 rawOrder) private view returns (bool found, uint256 index) {
        for (uint256 offset; offset < POOL_SIZE; ++offset) {
            index = (rawOrder % POOL_SIZE + offset) % POOL_SIZE;
            if (pool[index].status == ExpectedState.Unseen) return (true, index);
        }
    }

    function skip() private {
        ++coverage.skips;
        assertModel();
    }

    function capped(uint256 amount, uint256 remaining) private pure returns (uint256) {
        return amount < remaining ? amount : remaining;
    }

    // Independent fixed-width reference hashing; no Settlement or library hash getters.
    function domainBytes(ProtocolEncoding.Domain memory domain) private pure returns (bytes memory) {
        return abi.encodePacked(
            domain.sourceDomain, domain.destinationDomain, domain.solanaProgram, domain.chainId, domain.settlement
        );
    }

    function identityHash(ProtocolEncoding.Identity memory identity) private pure returns (bytes32) {
        return sha256(abi.encodePacked("CCSLID01", domainBytes(identity.domain), identity.user, identity.nonce));
    }

    function termsHash(ProtocolEncoding.Terms memory terms) private pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                "CCSLTR01",
                domainBytes(terms.identity.domain),
                identityHash(terms.identity),
                terms.identity.user,
                terms.identity.nonce,
                terms.market,
                terms.outcome,
                terms.cashAmount,
                terms.minimumShares
            )
        );
    }
}
