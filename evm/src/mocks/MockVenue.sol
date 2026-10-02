// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IMockVenueToken {
    function decimals() external view returns (uint8);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool);
}

/// @notice Local-demo venue for one YES market at 0.5 mock USD per YES.
/// @dev Uses prefunded, plain mock ERC20 inventory; purchases never mint tokens.
///      The caller supplies cash and receives YES (future settlement custody).
contract MockVenue {
    IMockVenueToken private immutable USD_TOKEN;
    IMockVenueToken private immutable YES_TOKEN;
    bytes32 private immutable MARKET;

    error InvalidTokens();
    error InvalidDecimals();
    error InvalidMarket(bytes32 market);
    error InvalidOutcome(uint8 outcome);
    error InvalidCashAmount(uint64 cashAmount);
    error InvalidMinimumShares();
    error MinimumNotMet(uint64 filledQuantity, uint64 minimumShares);
    error TokenTransferFailed(address token);

    event Purchased(address indexed buyer, bytes32 indexed market, uint64 cashAmount, uint64 filledQuantity);

    constructor(address usdToken_, address yesToken_, bytes32 market_) {
        if (usdToken_ == address(0) || yesToken_ == address(0) || usdToken_ == yesToken_) {
            revert InvalidTokens();
        }
        if (market_ == bytes32(0)) revert InvalidMarket(market_);
        IMockVenueToken usd = IMockVenueToken(usdToken_);
        IMockVenueToken yes = IMockVenueToken(yesToken_);
        if (usd.decimals() != 6 || yes.decimals() != 6) revert InvalidDecimals();
        USD_TOKEN = usd;
        YES_TOKEN = yes;
        MARKET = market_;
    }

    function usdToken() external view returns (IMockVenueToken) {
        return USD_TOKEN;
    }

    function yesToken() external view returns (IMockVenueToken) {
        return YES_TOKEN;
    }

    function market() external view returns (bytes32) {
        return MARKET;
    }

    /// @notice Buy an exact full fill with cash approved to this venue.
    /// @dev An unattainable nonzero minimum is valid input but reverts execution.
    ///      Any failed token call rolls back both payment and inventory delivery.
    function buy(bytes32 market_, uint8 outcome, uint64 cashAmount, uint64 minimumShares)
        external
        returns (uint64 filledQuantity)
    {
        if (market_ != MARKET) revert InvalidMarket(market_);
        if (outcome != 0) revert InvalidOutcome(outcome);
        if (cashAmount == 0 || cashAmount > type(uint64).max / 2) revert InvalidCashAmount(cashAmount);
        if (minimumShares == 0) revert InvalidMinimumShares();
        // Validate before multiplying or narrowing to the shared uint64 capacity.
        filledQuantity = uint64(uint256(cashAmount) * 2);
        if (filledQuantity < minimumShares) revert MinimumNotMet(filledQuantity, minimumShares);
        if (!USD_TOKEN.transferFrom(msg.sender, address(this), cashAmount)) {
            revert TokenTransferFailed(address(USD_TOKEN));
        }
        if (!YES_TOKEN.transfer(msg.sender, filledQuantity)) {
            revert TokenTransferFailed(address(YES_TOKEN));
        }
        emit Purchased(msg.sender, market_, cashAmount, filledQuantity);
    }
}
