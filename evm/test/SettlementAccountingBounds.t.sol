// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Settlement} from "../src/Settlement.sol";
import {ProtocolEncoding} from "../src/ProtocolEncoding.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";

interface AccountingVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address caller) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function store(address target, bytes32 slot, bytes32 value) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev Counter fault injection is not a reachable economic demo flow: token supply
///      is capped at uint64. Real purchases create every terminal record here.
contract SettlementAccountingBoundsTest {
    AccountingVm private constant VM = AccountingVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0x0F);
    address private constant EXECUTOR = address(0xE);
    bytes32 private constant MARKET = bytes32(uint256(0x66));
    uint64 private constant CASH = 10_000_000;
    uint64 private constant SHARES = 20_000_000;
    bytes32 private constant TERMINAL_EVENT = keccak256("TerminalRecorded(bytes32,bytes32,uint8,uint64,bytes32)");

    // Verified with solc 0.8.30 via:
    // forge inspect --root evm Settlement storage-layout --json --use "$LAB_ROOT/.local/solc-0.8.30"
    // orders: slot 0; totalCashSpent: slot 1, offset 0, 16 bytes;
    // totalSharesPurchased: slot 1, offset 16, 16 bytes; entered: slot 2.
    // Runtime getter/readback checks also detect a stale counter layout.
    bytes32 private constant COUNTERS_SLOT = bytes32(uint256(1));
    uint256 private constant CASH_SHIFT = 0;
    uint256 private constant SHARES_SHIFT = 16 * 8;
    MockERC20 private usd;
    MockERC20 private yes;
    MockVenue private venue;
    Settlement private settlement;

    function setUp() public {
        usd = new MockERC20("Mock USD", "mUSD", address(this));
        yes = new MockERC20("Mock YES", "mYES", address(this));
        venue = new MockVenue(address(usd), address(yes), MARKET);
        settlement = new Settlement(
            Settlement.Configuration(
                bytes32(uint256(0x11)),
                bytes32(uint256(0x22)),
                bytes32(uint256(0x33)),
                OPERATOR,
                EXECUTOR,
                address(usd),
                address(yes),
                address(venue),
                MARKET
            )
        );
        usd.mint(EXECUTOR, 3 * CASH);
        usd.mint(address(venue), 77);
        usd.mint(address(settlement), 333);
        yes.mint(address(venue), 3 * SHARES);
        yes.mint(address(settlement), 111);
        VM.prank(EXECUTOR);
        assert(usd.approve(address(settlement), 3 * CASH));
    }

    function testCashExactBoundaryAndTerminalReplay() public {
        seedCounters(type(uint128).max - CASH, 123);
        fillAndReplay(type(uint128).max, 123 + SHARES);
    }

    function testSharesExactBoundaryAndTerminalReplay() public {
        seedCounters(456, type(uint128).max - SHARES);
        fillAndReplay(456 + CASH, type(uint128).max);
    }

    function testCashOverflowRollsBackWholePurchaseAndGuard() public {
        seedCounters(type(uint128).max - CASH + 1, 123);
        overflowAndCancel();
    }

    function testSharesOverflowRollsBackEarlierCashIncrementAndGuard() public {
        seedCounters(456, type(uint128).max - SHARES + 1);
        overflowAndCancel();
    }

    function seedCounters(uint128 cash, uint128 shares) private {
        seedField(CASH_SHIFT, cash);
        seedField(SHARES_SHIFT, shares);
        assert(settlement.totalCashSpent() == cash && settlement.totalSharesPurchased() == shares);
    }

    /// @dev Preserve the neighboring packed counter on every individual field write.
    function seedField(uint256 shift, uint128 value) private {
        uint256 original = uint256(VM.load(address(settlement), COUNTERS_SLOT));
        uint256 mask = uint256(type(uint128).max) << shift;
        uint256 updated = (original & ~mask) | (uint256(value) << shift);
        VM.store(address(settlement), COUNTERS_SLOT, bytes32(updated));
        uint256 actual = uint256(VM.load(address(settlement), COUNTERS_SLOT));
        assert(actual == updated && (actual & ~mask) == (original & ~mask));
    }

    function fillAndReplay(uint128 expectedCash, uint128 expectedShares) private {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        VM.recordLogs();
        VM.prank(OPERATOR);
        ProtocolEncoding.Receipt memory receipt = settlement.execute(id, terms);
        assert(receipt.termsHash == ProtocolEncoding.termsHash(terms) && receipt.terminal == 1);
        assert(receipt.filledQuantity == SHARES);
        assert(settlement.totalCashSpent() == expectedCash && settlement.totalSharesPurchased() == expectedShares);
        assert(usd.balanceOf(EXECUTOR) == 2 * CASH && usd.balanceOf(address(venue)) == 77 + CASH);
        assert(usd.balanceOf(address(settlement)) == 333);
        assert(yes.balanceOf(address(venue)) == 2 * SHARES && yes.balanceOf(address(settlement)) == 111 + SHARES);
        assert(usd.allowance(EXECUTOR, address(settlement)) == 2 * CASH);
        assert(usd.allowance(address(settlement), address(venue)) == 0);
        assertTerminalCount(VM.getRecordedLogs(), 1);
        Settlement.OrderRecord memory expected = Settlement.OrderRecord(
            terms, receipt.termsHash, Settlement.State.Filled, SHARES, ProtocolEncoding.receiptHash(receipt)
        );
        assert(keccak256(abi.encode(settlement.orderRecord(id))) == keccak256(abi.encode(expected)));
        bytes32 beforeReplay = snapshot();
        bytes32 beforeRecord = keccak256(abi.encode(expected));
        for (uint256 i; i < 2; ++i) {
            VM.recordLogs();
            VM.prank(OPERATOR);
            ProtocolEncoding.Receipt memory replay =
                i == 0 ? settlement.execute(id, terms) : settlement.cancel(id, terms);
            assert(keccak256(abi.encode(replay)) == keccak256(abi.encode(receipt)));
            assert(snapshot() == beforeReplay);
            assert(keccak256(abi.encode(settlement.orderRecord(id))) == beforeRecord);
            assert(VM.getRecordedLogs().length == 0);
        }
    }

    function overflowAndCancel() private {
        ProtocolEncoding.Terms memory terms = defaultTerms();
        bytes32 id = ProtocolEncoding.orderId(terms.identity);
        Settlement.OrderRecord memory empty;
        assert(keccak256(abi.encode(settlement.orderRecord(id))) == keccak256(abi.encode(empty)));
        bytes32 beforePurchase = snapshot();
        bytes32 seededWord = VM.load(address(settlement), COUNTERS_SLOT);
        VM.recordLogs();
        VM.prank(OPERATOR);
        (bool success, bytes memory reason) = address(settlement).call(abi.encodeCall(settlement.execute, (id, terms)));
        assert(!success && keccak256(reason) == keccak256(abi.encodeWithSignature("Panic(uint256)", uint256(0x11))));
        assert(snapshot() == beforePurchase);
        assert(VM.load(address(settlement), COUNTERS_SLOT) == seededWord);
        assert(keccak256(abi.encode(settlement.orderRecord(id))) == keccak256(abi.encode(empty)));
        // Foundry can record transient reverted token logs. There is no terminal
        // emission even in that trace, and the failed EVM call commits no logs.
        assertTerminalCount(VM.getRecordedLogs(), 0);
        VM.recordLogs();
        VM.prank(OPERATOR);
        ProtocolEncoding.Receipt memory receipt = settlement.cancel(id, terms);
        assert(receipt.terminal == 2 && receipt.filledQuantity == 0);
        assert(receipt.termsHash == ProtocolEncoding.termsHash(terms));
        assert(snapshot() == beforePurchase); // Also proves both seeded totals stay intact.
        assertTerminalCount(VM.getRecordedLogs(), 1);
        Settlement.OrderRecord memory expected = Settlement.OrderRecord(
            terms, receipt.termsHash, Settlement.State.Cancelled, 0, ProtocolEncoding.receiptHash(receipt)
        );
        assert(keccak256(abi.encode(settlement.orderRecord(id))) == keccak256(abi.encode(expected)));
    }

    /// @dev Include every fixture actor, both supplies, both seeded counters,
    ///      and all pairwise allowances. No actual snapshot initializes the model.
    function snapshot() private view returns (bytes32) {
        address[6] memory actors = [EXECUTOR, OPERATOR, address(venue), address(settlement), address(this), address(0)];
        MockERC20[2] memory tokens = [usd, yes];
        uint256[12] memory balances;
        uint256[72] memory allowances;
        for (uint256 t; t < 2; ++t) {
            for (uint256 i; i < 6; ++i) {
                balances[t * 6 + i] = tokens[t].balanceOf(actors[i]);
                for (uint256 j; j < 6; ++j) {
                    allowances[t * 36 + i * 6 + j] = tokens[t].allowance(actors[i], actors[j]);
                }
            }
        }
        return keccak256(
            abi.encode(
                balances,
                allowances,
                usd.totalSupply(),
                yes.totalSupply(),
                settlement.totalCashSpent(),
                settlement.totalSharesPurchased()
            )
        );
    }

    function defaultTerms() private view returns (ProtocolEncoding.Terms memory) {
        return ProtocolEncoding.Terms(
            ProtocolEncoding.Identity(settlement.domain(), bytes32(uint256(0x55)), 7), MARKET, 0, CASH, SHARES
        );
    }

    function assertTerminalCount(AccountingVm.Log[] memory logs, uint256 expected) private view {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(settlement) && logs[i].topics.length != 0
                    && logs[i].topics[0] == TERMINAL_EVENT
            ) ++count;
        }
        assert(count == expected);
    }
}
