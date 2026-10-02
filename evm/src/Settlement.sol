// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolEncoding} from "./ProtocolEncoding.sol";
import {MockVenue, IMockVenueToken} from "./mocks/MockVenue.sol";

/// @notice Immutable local-demo settlement configuration and permanent terminal records.
/// @dev The EVM operator is trusted to forward only a finalized source user's
///      cancellation request. This contract cannot independently verify Solana.
///      EVM cancellation neither proves source finality nor performs a refund.
contract Settlement {
    enum State {
        Unseen,
        Filled,
        Cancelled
    }

    struct Configuration {
        bytes32 sourceDomain;
        bytes32 destinationDomain;
        bytes32 solanaProgram;
        address operator;
        address executor;
        address usdToken;
        address yesToken;
        address venue;
        bytes32 market;
    }

    struct OrderRecord {
        ProtocolEncoding.Terms terms;
        bytes32 termsHash;
        State status;
        uint64 filledQuantity;
        bytes32 receiptHash;
    }

    bytes32 private immutable SOURCE_DOMAIN;
    bytes32 private immutable DESTINATION_DOMAIN;
    bytes32 private immutable SOLANA_PROGRAM;
    uint256 private immutable CHAIN_ID;
    address private immutable OPERATOR;
    address private immutable EXECUTOR;
    address private immutable USD_TOKEN;
    address private immutable YES_TOKEN;
    address private immutable VENUE;
    bytes32 private immutable MARKET;
    mapping(bytes32 => OrderRecord) private orders;

    error InvalidDomains();
    error InvalidProgram();
    error InvalidAddress();
    error InvalidTokens();
    error InvalidDecimals();
    error InvalidVenueBindings();
    error UnauthorizedOperator();
    error ChainIdChanged();
    error InvalidRequestDomain();
    error InvalidOrderId();
    error InvalidUser();
    error InvalidMarket(bytes32 market);
    error InvalidOutcome(uint8 outcome);
    error InvalidCashAmount(uint64 cashAmount);
    error InvalidMinimumShares();
    error InvalidNonce();
    error TermsConflict(bytes32 orderId, bytes32 storedTermsHash, bytes32 suppliedTermsHash);

    event TerminalRecorded(
        bytes32 indexed orderId, bytes32 indexed termsHash, uint8 terminal, uint64 filledQuantity, bytes32 receiptHash
    );

    constructor(Configuration memory config) {
        if (
            config.sourceDomain == bytes32(0) || config.destinationDomain == bytes32(0)
                || config.sourceDomain == config.destinationDomain
        ) revert InvalidDomains();
        if (config.solanaProgram == bytes32(0)) revert InvalidProgram();
        if (config.operator == address(0) || config.executor == address(0) || config.venue == address(0)) {
            revert InvalidAddress();
        }
        if (config.usdToken == address(0) || config.yesToken == address(0) || config.usdToken == config.yesToken) {
            revert InvalidTokens();
        }
        if (config.market == bytes32(0)) revert InvalidMarket(config.market);
        if (IMockVenueToken(config.usdToken).decimals() != 6 || IMockVenueToken(config.yesToken).decimals() != 6) {
            revert InvalidDecimals();
        }
        MockVenue configuredVenue = MockVenue(config.venue);
        if (
            address(configuredVenue.usdToken()) != config.usdToken
                || address(configuredVenue.yesToken()) != config.yesToken || configuredVenue.market() != config.market
        ) revert InvalidVenueBindings();

        SOURCE_DOMAIN = config.sourceDomain;
        DESTINATION_DOMAIN = config.destinationDomain;
        SOLANA_PROGRAM = config.solanaProgram;
        CHAIN_ID = block.chainid;
        OPERATOR = config.operator;
        EXECUTOR = config.executor;
        USD_TOKEN = config.usdToken;
        YES_TOKEN = config.yesToken;
        VENUE = config.venue;
        MARKET = config.market;
    }

    /// @notice Canonical domain, including the captured deployment chain ID.
    function domain() external view returns (ProtocolEncoding.Domain memory) {
        return ProtocolEncoding.Domain(SOURCE_DOMAIN, DESTINATION_DOMAIN, SOLANA_PROGRAM, CHAIN_ID, address(this));
    }

    function operator() external view returns (address) {
        return OPERATOR;
    }

    function executor() external view returns (address) {
        return EXECUTOR;
    }

    function usdToken() external view returns (address) {
        return USD_TOKEN;
    }

    function yesToken() external view returns (address) {
        return YES_TOKEN;
    }

    function venue() external view returns (address) {
        return VENUE;
    }

    function market() external view returns (bytes32) {
        return MARKET;
    }

    /// @notice Unknown orders have an all-zero record, with no terminal receipt.
    function orderRecord(bytes32 orderId) external view returns (OrderRecord memory) {
        return orders[orderId];
    }

    /// @notice Permanently cancel an unseen order or return its existing terminal receipt.
    /// @dev Validate every request before any write or replay return. If execution
    ///      has already won, its stored Filled receipt is returned unchanged.
    function cancel(bytes32 orderId, ProtocolEncoding.Terms calldata terms)
        external
        returns (ProtocolEncoding.Receipt memory receipt)
    {
        bytes32 termsHash = validateRequest(orderId, terms);
        OrderRecord storage record = orders[orderId];
        if (record.status != State.Unseen) {
            if (record.termsHash != termsHash) revert TermsConflict(orderId, record.termsHash, termsHash);
            return ProtocolEncoding.Receipt(record.termsHash, uint8(record.status), record.filledQuantity);
        }

        receipt = ProtocolEncoding.Receipt(termsHash, uint8(State.Cancelled), 0);
        bytes32 receiptHash = ProtocolEncoding.receiptHash(receipt);
        orders[orderId] = OrderRecord({
            terms: terms, termsHash: termsHash, status: State.Cancelled, filledQuantity: 0, receiptHash: receiptHash
        });
        emit TerminalRecorded(orderId, termsHash, receipt.terminal, receipt.filledQuantity, receiptHash);
    }

    function validateRequest(bytes32 orderId, ProtocolEncoding.Terms calldata terms) private view returns (bytes32) {
        if (msg.sender != OPERATOR) revert UnauthorizedOperator();
        if (block.chainid != CHAIN_ID) revert ChainIdChanged();
        ProtocolEncoding.Domain calldata requestDomain = terms.identity.domain;
        if (
            requestDomain.sourceDomain != SOURCE_DOMAIN || requestDomain.destinationDomain != DESTINATION_DOMAIN
                || requestDomain.solanaProgram != SOLANA_PROGRAM || requestDomain.chainId != CHAIN_ID
                || requestDomain.settlement != address(this)
        ) revert InvalidRequestDomain();
        if (orderId != ProtocolEncoding.orderId(terms.identity)) revert InvalidOrderId();
        if (terms.identity.user == bytes32(0)) revert InvalidUser();
        if (terms.market != MARKET) revert InvalidMarket(terms.market);
        if (terms.outcome != 0) revert InvalidOutcome(terms.outcome);
        if (terms.cashAmount == 0 || terms.cashAmount > type(uint64).max / 2) {
            revert InvalidCashAmount(terms.cashAmount);
        }
        if (terms.minimumShares == 0) revert InvalidMinimumShares();
        if (terms.identity.nonce == type(uint64).max) revert InvalidNonce();
        return ProtocolEncoding.termsHash(terms);
    }
}
