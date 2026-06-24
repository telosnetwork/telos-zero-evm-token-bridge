// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {BridgeRegistry} from "../src/BridgeRegistry.sol";

contract RegisterPairs is Script {
    struct PairConfig {
        address evmToken;
        uint8 evmDecimals;
        bytes32 zeroAssetId;
        uint8 zeroDecimals;
        uint256 minAmount;
        uint256 maxAmount;
        uint256 dailyLimit;
    }

    function run() external {
        BridgeRegistry registry = BridgeRegistry(vm.envAddress("REGISTRY_ADDRESS"));

        PairConfig[3] memory pairs = [_pair("USDC"), _pair("USDT"), _pair("WBTC")];

        vm.startBroadcast();
        for (uint256 i = 0; i < pairs.length; i++) {
            registry.addPair(
                pairs[i].evmToken,
                pairs[i].evmDecimals,
                pairs[i].zeroAssetId,
                pairs[i].zeroDecimals,
                pairs[i].minAmount,
                pairs[i].maxAmount,
                pairs[i].dailyLimit
            );
        }
        vm.stopBroadcast();
    }

    function _pair(string memory prefix) internal view returns (PairConfig memory config) {
        config.evmToken = vm.envAddress(string.concat(prefix, "_EVM_TOKEN"));
        config.evmDecimals = uint8(vm.envUint(string.concat(prefix, "_EVM_DECIMALS")));
        config.zeroAssetId = vm.envBytes32(string.concat(prefix, "_ZERO_ASSET_ID"));
        config.zeroDecimals = uint8(vm.envUint(string.concat(prefix, "_ZERO_DECIMALS")));
        config.minAmount = vm.envUint(string.concat(prefix, "_MIN_AMOUNT"));
        config.maxAmount = vm.envUint(string.concat(prefix, "_MAX_AMOUNT"));
        config.dailyLimit = vm.envUint(string.concat(prefix, "_DAILY_LIMIT"));
    }
}
