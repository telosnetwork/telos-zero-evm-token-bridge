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
    error UnsupportedTokenBehavior();
    error InvalidRequest();
    error NotRequestSender();

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
    // Append storage: native code reads processedZeroBurns at its existing slot 6.
    mapping(uint256 pairId => mapping(uint256 day => uint256 amount)) public dailyReleases;

    event PausedSet(bool paused);
    event DepositRefundRequested(uint256 indexed requestId, bytes32 indexed requestHash);
    event DepositRefunded(uint256 indexed requestId, bytes32 indexed requestHash);
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
        if (!_isCanonicalZeroName(bytes(zeroReceiver))) revert InvalidReceiver();

        _consumeDailyLimit(pairId, pair.dailyLimit, amount);

        requestId = nextRequestId++;
        bytes32 zeroReceiverHash = sha256(bytes(zeroReceiver));
        bytes32 requestHash = keccak256(
            abi.encode(block.chainid, address(this), requestId, pairId, msg.sender, zeroReceiverHash, amount)
        );

        IERC20 token = IERC20(pair.evmToken);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != balanceBefore + amount) revert UnsupportedTokenBehavior();
        if (pair.mintBurn) {
            IBridgeMintBurnERC20(pair.evmToken).burn(amount);
            if (token.balanceOf(address(this)) != balanceBefore) revert UnsupportedTokenBehavior();
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
        if (receiver == address(0) || receiver == address(this) || zeroBurnId == bytes32(0)) revert InvalidReceiver();
        if (processedZeroBurns[zeroBurnId]) revert ZeroBurnAlreadyProcessed();

        uint256 day = block.timestamp / 1 days;
        uint256 nextAmount = dailyReleases[pairId][day] + amount;
        if (nextAmount > pair.dailyLimit) revert DailyLimitExceeded();
        dailyReleases[pairId][day] = nextAmount;

        processedZeroBurns[zeroBurnId] = true;
        _pay(pair, receiver, amount);

        emit ZeroToEvmReleased(zeroBurnId, pairId, receiver, amount, zeroSender);
    }

    function _checkAmount(BridgeRegistry.Pair memory pair, uint256 amount) internal pure {
        if (amount < pair.minAmount || amount > pair.maxAmount) revert InvalidAmount();
        // Match the native uint128 conversion and Antelope asset range exactly.
        if (amount > type(uint128).max) revert InvalidAmount();
        uint256 nativeAmount = amount;
        if (pair.evmDecimals > pair.zeroDecimals) {
            uint256 factor = 10 ** (pair.evmDecimals - pair.zeroDecimals);
            if (amount % factor != 0) revert InvalidAmount();
            nativeAmount = amount / factor;
        } else if (pair.zeroDecimals > pair.evmDecimals) {
            nativeAmount = amount * 10 ** (pair.zeroDecimals - pair.evmDecimals);
        }
        if (nativeAmount == 0 || nativeAmount > (uint256(1) << 62) - 1) revert InvalidAmount();
    }

    // Only the depositor can request cancellation. The native bridge must then
    // prove that it has never issued this request before returning funds.
    function requestDepositRefund(uint256 requestId) external nonReentrant {
        EvmToZeroRequest storage request = evmToZeroRequests[requestId];
        if (request.id == 0 || requestProofStatus(request.requestHash) != 1) revert InvalidRequest();
        if (msg.sender != request.sender) revert NotRequestSender();
        _setProofStatus(request.requestHash, 2);
        emit DepositRefundRequested(requestId, request.requestHash);
    }

    function refundDeposit(uint256 requestId, bytes32 requestHash) external nonReentrant onlyZeroBridge {
        EvmToZeroRequest storage request = evmToZeroRequests[requestId];
        if (request.id == 0 || request.requestHash != requestHash || requestProofStatus(requestHash) != 2) {
            revert InvalidRequest();
        }
        _setProofStatus(requestHash, 3);
        // Recovery remains available while new transfers/pairs are paused.
        _pay(registry.getPair(request.pairId), request.sender, request.amount);
        emit DepositRefunded(requestId, requestHash);
    }

    // 0: unknown; 1: mintable; 2: cancellation requested; 3: refunded.
    function requestProofStatus(bytes32 requestHash) public view returns (uint256 status) {
        bytes32 slot = requestProofSlot(requestHash, 5);
        assembly { status := sload(slot) }
    }

    function _setProofStatus(bytes32 requestHash, uint256 status) internal {
        bytes32 slot = requestProofSlot(requestHash, 5);
        assembly { sstore(slot, status) }
    }

    function _pay(BridgeRegistry.Pair memory pair, address receiver, uint256 amount) internal {
        IERC20 token = IERC20(pair.evmToken);
        uint256 receiverBefore = token.balanceOf(receiver);
        if (pair.mintBurn) {
            IBridgeMintBurnERC20(pair.evmToken).mint(receiver, amount);
        } else {
            uint256 escrowBefore = token.balanceOf(address(this));
            token.safeTransfer(receiver, amount);
            if (token.balanceOf(address(this)) + amount != escrowBefore) revert UnsupportedTokenBehavior();
        }
        if (token.balanceOf(receiver) != receiverBefore + amount) revert UnsupportedTokenBehavior();
    }

    function _isCanonicalZeroName(bytes memory value) internal pure returns (bool) {
        if (value.length == 0 || value.length > 13 || value[value.length - 1] == 0x2e) return false;
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            bool digit = c >= 0x31 && c <= 0x35;
            bool letter = c >= 0x61 && c <= (i == 12 ? bytes1(0x6a) : bytes1(0x7a));
            if (c != 0x2e && !digit && !letter) return false;
        }
        return true;
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

        proof.exists = existsWord == 1;
    }
}
