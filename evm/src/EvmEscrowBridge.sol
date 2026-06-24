// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeRegistry} from "./BridgeRegistry.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {Owned} from "./utils/Owned.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

interface IBridgeMintBurnERC20 is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

contract EvmEscrowBridge is Owned, ReentrancyGuard {
    using SafeTransferLib for IERC20;

    error BridgePaused();
    error NotZeroBridge();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidReceiver();
    error InvalidProofOffset();
    error DailyLimitExceeded();
    error ZeroBurnAlreadyProcessed();

    bytes32 public constant REQUEST_PROOF_STORAGE_SLOT =
        0xf981179bb6ca7bacd9c09fc7ee84e06aaea9dc6e23314fa01335b762685e87c1;
    uint256 public constant REQUEST_PROOF_FIELD_COUNT = 6;

    struct EvmToZeroRequest {
        uint256 id;
        uint256 pairId;
        address sender;
        string zeroReceiver;
        uint256 amount;
        uint64 createdAt;
        bytes32 requestHash;
    }

    struct RequestProof {
        uint256 pairId;
        uint256 amount;
        bytes32 sender;
        bytes32 zeroReceiverHash;
        uint256 createdAt;
        bool exists;
    }

    BridgeRegistry public immutable registry;
    address public immutable zeroBridge;
    bool public paused;
    uint256 public nextRequestId = 1;

    mapping(uint256 requestId => EvmToZeroRequest request) public evmToZeroRequests;
    mapping(bytes32 zeroBurnId => bool processed) public processedZeroBurns;
    mapping(uint256 pairId => mapping(uint256 day => uint256 amount)) public dailyDeposits;

    event PausedSet(bool paused);
    event EvmToZeroRequested(
        uint256 indexed requestId,
        uint256 indexed pairId,
        address indexed sender,
        string zeroReceiver,
        uint256 amount,
        bytes32 requestHash
    );
    event ZeroToEvmReleased(
        bytes32 indexed zeroBurnId, uint256 indexed pairId, address indexed receiver, uint256 amount, string zeroSender
    );

    constructor(address initialOwner, BridgeRegistry initialRegistry, address initialZeroBridge) Owned(initialOwner) {
        if (address(initialRegistry) == address(0) || initialZeroBridge == address(0)) revert InvalidAddress();
        registry = initialRegistry;
        zeroBridge = initialZeroBridge;
    }

    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    modifier onlyZeroBridge() {
        _requireZeroBridge();
        _;
    }

    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PausedSet(newPaused);
    }

    function depositToZero(uint256 pairId, uint256 amount, string calldata zeroReceiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        BridgeRegistry.Pair memory pair = registry.requireActivePair(pairId);
        _checkAmount(pair, amount);
        if (bytes(zeroReceiver).length == 0 || bytes(zeroReceiver).length > 64) revert InvalidReceiver();

        _consumeDailyLimit(pairId, pair.dailyLimit, amount);

        requestId = nextRequestId++;
        bytes32 zeroReceiverHash = sha256(bytes(zeroReceiver));
        bytes32 requestHash = keccak256(
            abi.encode(block.chainid, address(this), requestId, pairId, msg.sender, zeroReceiverHash, amount)
        );

        IERC20(pair.evmToken).safeTransferFrom(msg.sender, address(this), amount);
        if (pair.mintBurn) {
            IBridgeMintBurnERC20(pair.evmToken).burn(amount);
        }

        evmToZeroRequests[requestId] = EvmToZeroRequest({
            id: requestId,
            pairId: pairId,
            sender: msg.sender,
            zeroReceiver: zeroReceiver,
            amount: amount,
            createdAt: uint64(block.timestamp),
            requestHash: requestHash
        });
        _storeRequestProof(requestHash, pairId, amount, msg.sender, zeroReceiverHash, block.timestamp);

        emit EvmToZeroRequested(requestId, pairId, msg.sender, zeroReceiver, amount, requestHash);
    }

    function requestProofs(bytes32 requestHash)
        external
        view
        returns (
            uint256 pairId,
            uint256 amount,
            bytes32 sender,
            bytes32 zeroReceiverHash,
            uint256 createdAt,
            bool exists
        )
    {
        RequestProof memory proof = _readRequestProof(requestHash);
        return (proof.pairId, proof.amount, proof.sender, proof.zeroReceiverHash, proof.createdAt, proof.exists);
    }

    function requestProofSlot(bytes32 requestHash, uint256 offset) public pure returns (bytes32) {
        if (offset >= REQUEST_PROOF_FIELD_COUNT) revert InvalidProofOffset();
        return bytes32(uint256(_requestProofBaseSlot(requestHash)) + offset);
    }

    function releaseToEvm(
        uint256 pairId,
        uint256 amount,
        address receiver,
        bytes32 zeroBurnId,
        string calldata zeroSender
    ) external nonReentrant whenNotPaused onlyZeroBridge {
        BridgeRegistry.Pair memory pair = registry.requireActivePair(pairId);
        _checkAmount(pair, amount);
        if (receiver == address(0) || zeroBurnId == bytes32(0)) revert InvalidReceiver();
        if (processedZeroBurns[zeroBurnId]) revert ZeroBurnAlreadyProcessed();

        processedZeroBurns[zeroBurnId] = true;
        if (pair.mintBurn) {
            IBridgeMintBurnERC20(pair.evmToken).mint(receiver, amount);
        } else {
            IERC20(pair.evmToken).safeTransfer(receiver, amount);
        }

        emit ZeroToEvmReleased(zeroBurnId, pairId, receiver, amount, zeroSender);
    }

    function _checkAmount(BridgeRegistry.Pair memory pair, uint256 amount) internal pure {
        if (amount < pair.minAmount || amount > pair.maxAmount) revert InvalidAmount();
    }

    function _requireNotPaused() internal view {
        if (paused) revert BridgePaused();
    }

    function _requireZeroBridge() internal view {
        if (msg.sender != zeroBridge) revert NotZeroBridge();
    }

    function _consumeDailyLimit(uint256 pairId, uint256 dailyLimit, uint256 amount) internal {
        uint256 day = block.timestamp / 1 days;
        uint256 nextAmount = dailyDeposits[pairId][day] + amount;
        if (nextAmount > dailyLimit) revert DailyLimitExceeded();
        dailyDeposits[pairId][day] = nextAmount;
    }

    function _requestProofBaseSlot(bytes32 requestHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(requestHash, REQUEST_PROOF_STORAGE_SLOT));
    }

    function _storeRequestProof(
        bytes32 requestHash,
        uint256 pairId,
        uint256 amount,
        address sender,
        bytes32 zeroReceiverHash,
        uint256 createdAt
    ) internal {
        bytes32 baseSlot = _requestProofBaseSlot(requestHash);
        bytes32 senderWord = bytes32(uint256(uint160(sender)));

        assembly {
            sstore(baseSlot, pairId)
            sstore(add(baseSlot, 1), amount)
            sstore(add(baseSlot, 2), senderWord)
            sstore(add(baseSlot, 3), zeroReceiverHash)
            sstore(add(baseSlot, 4), createdAt)
            sstore(add(baseSlot, 5), 1)
        }
    }

    function _readRequestProof(bytes32 requestHash) internal view returns (RequestProof memory proof) {
        bytes32 baseSlot = _requestProofBaseSlot(requestHash);
        uint256 existsWord;

        assembly {
            mstore(proof, sload(baseSlot))
            mstore(add(proof, 0x20), sload(add(baseSlot, 1)))
            mstore(add(proof, 0x40), sload(add(baseSlot, 2)))
            mstore(add(proof, 0x60), sload(add(baseSlot, 3)))
            mstore(add(proof, 0x80), sload(add(baseSlot, 4)))
            existsWord := sload(add(baseSlot, 5))
        }

        proof.exists = existsWord != 0;
    }
}
