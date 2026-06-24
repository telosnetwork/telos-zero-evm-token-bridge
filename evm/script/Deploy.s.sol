// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {BridgeRegistry} from "../src/BridgeRegistry.sol";
import {EvmEscrowBridge} from "../src/EvmEscrowBridge.sol";

contract Deploy is Script {
    function run() external returns (BridgeRegistry registry, EvmEscrowBridge bridge) {
        address owner = vm.envAddress("BRIDGE_OWNER");
        address zeroBridge = vm.envAddress("ZERO_BRIDGE_EVM_ADDRESS");

        vm.startBroadcast();
        registry = new BridgeRegistry(owner);
        bridge = new EvmEscrowBridge(owner, registry, zeroBridge);
        vm.stopBroadcast();
    }
}
