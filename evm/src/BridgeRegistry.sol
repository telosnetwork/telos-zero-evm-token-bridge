// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned} from "./utils/Owned.sol";
import {IERC20} from "./interfaces/IERC20.sol";

contract BridgeRegistry is Owned {
    error InvalidToken();
    error InvalidDecimals();
    error InvalidLimits();
    error PairNotFound();
    error PairInactive();
    error TokenAlreadyRegistered();

    struct Pair {
        bool exists;
        bool active;
        bool mintBurn;
        address evmToken;
        uint8 evmDecimals;
        bytes32 zeroAssetId;
        uint8 zeroDecimals;
        uint256 minAmount;
        uint256 maxAmount;
        uint256 dailyLimit;
    }

    uint256 public nextPairId = 1;

    mapping(uint256 pairId => Pair pair) private pairs;
    mapping(address evmToken => uint256 pairId) public pairByEvmToken;

    event PairAdded(
        uint256 indexed pairId,
        address indexed evmToken,
        bytes32 indexed zeroAssetId,
        uint8 evmDecimals,
        uint8 zeroDecimals,
        uint256 minAmount,
        uint256 maxAmount,
        uint256 dailyLimit,
        bool mintBurn
    );
    event PairActiveSet(uint256 indexed pairId, bool active);
    event PairLimitsSet(uint256 indexed pairId, uint256 minAmount, uint256 maxAmount, uint256 dailyLimit);

    constructor(address initialOwner) Owned(initialOwner) {}

    function addPair(
        address evmToken,
        uint8 evmDecimals,
        bytes32 zeroAssetId,
        uint8 zeroDecimals,
        uint256 minAmount,
        uint256 maxAmount,
        uint256 dailyLimit
    ) external onlyOwner returns (uint256 pairId) {
        pairId = _addPair(evmToken, evmDecimals, zeroAssetId, zeroDecimals, minAmount, maxAmount, dailyLimit, false);
    }

    function addMintBurnPair(
        address evmToken,
        uint8 evmDecimals,
        bytes32 zeroAssetId,
        uint8 zeroDecimals,
        uint256 minAmount,
        uint256 maxAmount,
        uint256 dailyLimit
    ) external onlyOwner returns (uint256 pairId) {
        pairId = _addPair(evmToken, evmDecimals, zeroAssetId, zeroDecimals, minAmount, maxAmount, dailyLimit, true);
    }

    function _addPair(
        address evmToken,
        uint8 evmDecimals,
        bytes32 zeroAssetId,
        uint8 zeroDecimals,
        uint256 minAmount,
        uint256 maxAmount,
        uint256 dailyLimit,
        bool mintBurn
    ) internal returns (uint256 pairId) {
        if (evmToken.code.length == 0) revert InvalidToken();
        if (evmDecimals > 36 || zeroDecimals > 18 || IERC20(evmToken).decimals() != evmDecimals) {
            revert InvalidDecimals();
        }
        if (zeroAssetId == bytes32(0)) revert InvalidToken();
        if (minAmount == 0 || maxAmount < minAmount || dailyLimit < maxAmount) revert InvalidLimits();
        if (pairByEvmToken[evmToken] != 0) revert TokenAlreadyRegistered();

        pairId = nextPairId++;
        pairs[pairId] = Pair({
            exists: true,
            active: true,
            mintBurn: mintBurn,
            evmToken: evmToken,
            evmDecimals: evmDecimals,
            zeroAssetId: zeroAssetId,
            zeroDecimals: zeroDecimals,
            minAmount: minAmount,
            maxAmount: maxAmount,
            dailyLimit: dailyLimit
        });
        pairByEvmToken[evmToken] = pairId;

        emit PairAdded(
            pairId, evmToken, zeroAssetId, evmDecimals, zeroDecimals, minAmount, maxAmount, dailyLimit, mintBurn
        );
    }

    function setPairActive(uint256 pairId, bool active) external onlyOwner {
        Pair storage pair = pairs[pairId];
        if (!pair.exists) revert PairNotFound();
        pair.active = active;
        emit PairActiveSet(pairId, active);
    }

    function setPairLimits(uint256 pairId, uint256 minAmount, uint256 maxAmount, uint256 dailyLimit)
        external
        onlyOwner
    {
        Pair storage pair = pairs[pairId];
        if (!pair.exists) revert PairNotFound();
        if (minAmount == 0 || maxAmount < minAmount || dailyLimit < maxAmount) revert InvalidLimits();
        pair.minAmount = minAmount;
        pair.maxAmount = maxAmount;
        pair.dailyLimit = dailyLimit;
        emit PairLimitsSet(pairId, minAmount, maxAmount, dailyLimit);
    }

    function getPair(uint256 pairId) external view returns (Pair memory pair) {
        pair = pairs[pairId];
        if (!pair.exists) revert PairNotFound();
    }

    function requireActivePair(uint256 pairId) external view returns (Pair memory pair) {
        pair = pairs[pairId];
        if (!pair.exists) revert PairNotFound();
        if (!pair.active) revert PairInactive();
    }
}
