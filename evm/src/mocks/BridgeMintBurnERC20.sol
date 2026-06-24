// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {Owned} from "../utils/Owned.sol";

contract BridgeMintBurnERC20 is IERC20, Owned {
    error NotBridge();

    string public name;
    string public symbol;
    uint8 private immutable DECIMALS;
    uint256 public totalSupply;
    address public bridge;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event BridgeSet(address indexed bridge);

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals, address initialOwner)
        Owned(initialOwner)
    {
        name = tokenName;
        symbol = tokenSymbol;
        DECIMALS = tokenDecimals;
    }

    modifier onlyBridge() {
        if (msg.sender != bridge) revert NotBridge();
        _;
    }

    function decimals() external view returns (uint8) {
        return DECIMALS;
    }

    function setBridge(address newBridge) external onlyOwner {
        if (newBridge == address(0)) revert ZeroAddress();
        bridge = newBridge;
        emit BridgeSet(newBridge);
    }

    function mint(address to, uint256 amount) external onlyBridge {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external onlyBridge {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
