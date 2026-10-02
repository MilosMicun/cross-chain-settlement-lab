// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Restricted local-demo mock with six decimals and uint64 supply capacity.
/// @dev Not a general production ERC20 implementation. Only the immutable fixture
///      authority can mint; there are no fees, callbacks, burns, or rescue paths.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 private constant DECIMALS = 6;
    address private immutable MINT_AUTHORITY;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InvalidAddress();
    error UnauthorizedMint();
    error SupplyCapExceeded();
    error InsufficientBalance();
    error InsufficientAllowance();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, address mintAuthority_) {
        if (mintAuthority_ == address(0)) revert InvalidAddress();
        name = name_;
        symbol = symbol_;
        MINT_AUTHORITY = mintAuthority_;
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function mintAuthority() external view returns (address) {
        return MINT_AUTHORITY;
    }

    function mint(address recipient, uint256 amount) external {
        if (msg.sender != MINT_AUTHORITY) revert UnauthorizedMint();
        if (recipient == address(0)) revert InvalidAddress();
        if (amount > type(uint64).max - totalSupply) revert SupplyCapExceeded();
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        transferTokens(msg.sender, recipient, amount);
        return true;
    }

    /// @dev Maximum uint256 allowance is unlimited and is never decremented.
    ///      Finite allowance is consumed even when the spender is the owner.
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        uint256 available = allowance[owner][msg.sender];
        if (available != type(uint256).max) {
            if (amount > available) revert InsufficientAllowance();
            allowance[owner][msg.sender] = available - amount;
            emit Approval(owner, msg.sender, available - amount);
        }
        transferTokens(owner, recipient, amount);
        return true;
    }

    function transferTokens(address owner, address recipient, uint256 amount) private {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount > balanceOf[owner]) revert InsufficientBalance();
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(owner, recipient, amount);
    }
}
