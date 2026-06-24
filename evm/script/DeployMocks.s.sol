// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract DeployMocks is Script {
    function run() external returns (MockERC20 usdc, MockERC20 usdt, MockERC20 wbtc) {
        address initialHolder = vm.envAddress("MOCK_INITIAL_HOLDER");

        vm.startBroadcast();
        usdc = new MockERC20("Test USDC.e", "USDC.e", 6);
        usdt = new MockERC20("Test USDT", "USDT", 6);
        wbtc = new MockERC20("Test WBTC", "WBTC", 8);

        usdc.mint(initialHolder, 1_000_000_000e6);
        usdt.mint(initialHolder, 1_000_000_000e6);
        wbtc.mint(initialHolder, 21_000e8);
        vm.stopBroadcast();
    }
}
