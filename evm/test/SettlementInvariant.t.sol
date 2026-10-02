// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SettlementHandler} from "./handlers/SettlementHandler.sol";

/// @dev Foundry reads this metadata directly; these are not Vm cheatcodes.
contract SettlementInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    SettlementHandler private handler;

    event log_named_uint(string key, uint256 value);

    function setUp() public {
        handler = new SettlementHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.execute.selector;
        selectors[1] = handler.cancel.selector;
        selectors[2] = handler.race.selector;
        selectors[3] = handler.replay.selector;
        selectors[4] = handler.conflict.selector;
        selectors[5] = handler.setAllowance.selector;
        selectors[6] = handler.fund.selector;
        selectors[7] = handler.replenish.selector;
        selectors[8] = handler.donate.selector;
        selectors[9] = handler.restore.selector;
        selectors[10] = handler.failAllowance.selector;
        selectors[11] = handler.failInventory.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector({addr: address(handler), selectors: selectors});
    }

    // Explicit empty optional metadata avoids missing-function probe warnings in
    // Foundry 1.5.1. Only targetContracts/targetSelectors above select fuzz actions.
    function targetArtifactSelectors() external pure returns (FuzzArtifactSelector[] memory) {
        return new FuzzArtifactSelector[](0);
    }

    function targetArtifacts() external pure returns (string[] memory) {
        return new string[](0);
    }

    function excludeArtifacts() external pure returns (string[] memory) {
        return new string[](0);
    }

    function targetSenders() external pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeSenders() external pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeContracts() external pure returns (address[] memory) {
        return new address[](0);
    }

    function targetInterfaces() external pure returns (FuzzInterface[] memory) {
        return new FuzzInterface[](0);
    }

    function excludeSelectors() external pure returns (FuzzSelector[] memory) {
        return new FuzzSelector[](0);
    }

    function invariantRecordsAndEconomicsMatchIndependentModel() public view {
        handler.assertModel();
    }

    /// @dev Semantic counts describe outcomes, not merely selector invocations.
    ///      No minimum coverage is imposed on individual random sequences.
    ///      Forge displays this hook's logs for the last sequence, not campaign totals.
    function afterInvariant() public {
        reportMetrics();
    }

    function testSmokeRequiredSemanticBranches() public {
        handler.failInventory(0, false); // Failure -> inventory transfer -> fill.
        handler.failInventory(1, true); // Failure -> cancel -> restore -> rejected execution.
        handler.failAllowance(2, false); // Failure -> approval/inventory restoration -> fill.
        handler.failAllowance(3, true); // Failure -> cancel -> restore -> rejected execution.
        handler.restore(4);
        handler.race(4, true); // Execution wins; cancellation returns Filled.
        handler.race(5, false); // Cancellation wins; delayed execution is rejected.
        handler.replay(0, true);
        handler.replay(0, false);
        handler.replay(1, false);
        handler.replay(1, true);
        handler.conflict(0, true, true);
        handler.conflict(0, false, false);
        handler.conflict(1, true, false);
        handler.conflict(1, false, true);
        handler.donate(123, false);
        handler.donate(456, true);
        handler.setAllowance(0);
        handler.execute(6); // Ordinary execution also predicts the allowance failure.
        handler.restore(6);
        handler.execute(6);
        handler.setAllowance(50_000_000);
        handler.replenish(3_000_000);
        handler.execute(7); // Executor cash failure, distinct from inventory/allowance.
        handler.fund(2_000_000);
        handler.execute(7);
        handler.replay(11, true); // Explicit no-op coverage, never counted as a fill.
        handler.restore(11);
        handler.restore(11); // Already restored: another honest no-op.
        handler.assertModel();
        SettlementHandler.Metrics memory m = handler.metrics();
        assert(m.fills == 5 && m.cancellations == 3);
        assert(m.filledExecutionReplays == 1 && m.filledCancellationReplays == 2 && m.cancelledReplays == 1);
        assert(m.delayedExecutions == 4 && m.conflicts == 4);
        assert(m.allowanceFailures == 3 && m.inventoryFailures == 2 && m.cashFailures == 1);
        assert(m.failureThenFill == 2 && m.failureThenCancel == 2 && m.restorations > 0);
        assert(m.fundingTransfers > 0 && m.inventoryTransfers > 0);
        assert(m.usdDonations == 1 && m.yesDonations == 1 && m.skips == 2);
        reportMetrics();
    }

    function reportMetrics() private {
        SettlementHandler.Metrics memory m = handler.metrics();
        emit log_named_uint("actions", m.actions);
        emit log_named_uint("settlement calls", m.settlementCalls);
        emit log_named_uint("new fills", m.fills);
        emit log_named_uint("new cancellations", m.cancellations);
        emit log_named_uint("Filled execute replays", m.filledExecutionReplays);
        emit log_named_uint("Filled cancel replays", m.filledCancellationReplays);
        emit log_named_uint("Cancelled replays", m.cancelledReplays);
        emit log_named_uint("rejected delayed executions", m.delayedExecutions);
        emit log_named_uint("allowance failures", m.allowanceFailures);
        emit log_named_uint("cash failures", m.cashFailures);
        emit log_named_uint("inventory failures", m.inventoryFailures);
        emit log_named_uint("valid-term conflicts", m.conflicts);
        emit log_named_uint("restorations", m.restorations);
        emit log_named_uint("failure then fill", m.failureThenFill);
        emit log_named_uint("failure then cancel", m.failureThenCancel);
        emit log_named_uint("funding transfers", m.fundingTransfers);
        emit log_named_uint("inventory transfers", m.inventoryTransfers);
        emit log_named_uint("USD donations", m.usdDonations);
        emit log_named_uint("YES donations", m.yesDonations);
        emit log_named_uint("skipped actions", m.skips);
    }
}
