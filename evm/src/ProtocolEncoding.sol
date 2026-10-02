// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Canonical v1 fixed-width encoding and SHA-256 hashing from SPEC.md.
/// @dev Encoding does not establish authorization, deployment validity, or execution.
library ProtocolEncoding {
    struct Domain {
        bytes32 sourceDomain;
        bytes32 destinationDomain;
        bytes32 solanaProgram;
        uint256 chainId;
        address settlement;
    }

    struct Identity {
        Domain domain;
        bytes32 user;
        uint64 nonce;
    }

    struct Terms {
        Identity identity;
        bytes32 market;
        uint8 outcome;
        uint64 cashAmount;
        uint64 minimumShares;
    }

    struct Receipt {
        bytes32 termsHash;
        uint8 terminal;
        uint64 filledQuantity;
    }

    uint8 internal constant FILLED = 1;
    uint8 internal constant CANCELLED = 2;

    error InvalidTerminal(uint8 terminal);

    /// @return The 196-byte identity preimage (nonce is eight-byte big-endian).
    function identityBytes(Identity memory identity) internal pure returns (bytes memory) {
        return abi.encodePacked("CCSLID01", domainBytes(identity.domain), identity.user, identity.nonce);
    }

    function orderId(Identity memory identity) internal pure returns (bytes32) {
        return sha256(identityBytes(identity));
    }

    /// @return The 277-byte terms preimage, including the derived order ID.
    function termsBytes(Terms memory terms) internal pure returns (bytes memory) {
        return abi.encodePacked(
            "CCSLTR01",
            domainBytes(terms.identity.domain),
            orderId(terms.identity),
            terms.identity.user,
            terms.identity.nonce,
            terms.market,
            terms.outcome,
            terms.cashAmount,
            terms.minimumShares
        );
    }

    function termsHash(Terms memory terms) internal pure returns (bytes32) {
        return sha256(termsBytes(terms));
    }

    /// @return The 49-byte receipt preimage (terminal: one byte; quantity: eight bytes).
    /// @dev Checks only terminal = 1 (Filled) or 2 (Cancelled). Does not validate
    ///      quantity, its relation to terms, or whether execution occurred.
    function receiptBytes(Receipt memory receipt) internal pure returns (bytes memory) {
        if (receipt.terminal != FILLED && receipt.terminal != CANCELLED) {
            revert InvalidTerminal(receipt.terminal);
        }
        return abi.encodePacked("CCSLRC01", receipt.termsHash, receipt.terminal, receipt.filledQuantity);
    }

    function receiptHash(Receipt memory receipt) internal pure returns (bytes32) {
        return sha256(receiptBytes(receipt));
    }

    /// @dev D is 148 bytes: three raw 32-byte identities, a 32-byte big-endian
    ///      chain ID, and a raw 20-byte EVM address (without ABI word padding).
    function domainBytes(Domain memory domain) private pure returns (bytes memory) {
        return abi.encodePacked(
            domain.sourceDomain, domain.destinationDomain, domain.solanaProgram, domain.chainId, domain.settlement
        );
    }
}
