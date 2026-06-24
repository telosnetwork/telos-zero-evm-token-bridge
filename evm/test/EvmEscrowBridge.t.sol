// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BridgeRegistry} from "../src/BridgeRegistry.sol";
import {EvmEscrowBridge} from "../src/EvmEscrowBridge.sol";
import {BridgeMintBurnERC20} from "../src/mocks/BridgeMintBurnERC20.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract EvmEscrowBridgeTest is Test {
    address internal owner = address(0xA11CE);
    address internal zeroBridge = address(0xB0126E);
    address internal user = address(0xCAFE);
    address internal receiver = address(0xBEEF);

    BridgeRegistry internal registry;
    EvmEscrowBridge internal bridge;
    MockERC20 internal usdc;
    uint256 internal pairId;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new MockERC20("USD Coin", "USDC.e", 6);
        registry = new BridgeRegistry(owner);
        pairId = registry.addPair(address(usdc), 6, keccak256("ZUSDC:usdc.test"), 6, 1e6, 10_000e6, 50_000e6);
        bridge = new EvmEscrowBridge(owner, registry, zeroBridge);
        vm.stopPrank();

        usdc.mint(user, 100_000e6);
        vm.prank(user);
        usdc.approve(address(bridge), type(uint256).max);
    }

    function testDepositToZeroEscrowsTokensAndCreatesRequest() public {
        vm.prank(user);
        uint256 requestId = bridge.depositToZero(pairId, 1_000e6, "alice.zero");

        assertEq(requestId, 1);
        assertEq(usdc.balanceOf(address(bridge)), 1_000e6);
        assertEq(usdc.balanceOf(user), 99_000e6);

        (
            uint256 id,
            uint256 storedPairId,
            address sender,
            string memory zeroReceiver,
            uint256 amount,
            uint64 createdAt,
            bytes32 requestHash
        ) = bridge.evmToZeroRequests(requestId);

        assertEq(id, requestId);
        assertEq(storedPairId, pairId);
        assertEq(sender, user);
        assertEq(zeroReceiver, "alice.zero");
        assertEq(amount, 1_000e6);
        assertEq(createdAt, block.timestamp);
        assertEq(
            requestHash,
            keccak256(
                abi.encode(
                    block.chainid, address(bridge), requestId, pairId, user, sha256(bytes("alice.zero")), 1_000e6
                )
            )
        );

        (
            uint256 proofPairId,
            uint256 proofAmount,
            bytes32 proofSender,
            bytes32 proofZeroReceiverHash,
            uint256 proofCreatedAt,
            bool proofExists
        ) = bridge.requestProofs(requestHash);

        assertTrue(proofExists);
        assertEq(proofPairId, pairId);
        assertEq(proofAmount, 1_000e6);
        assertEq(proofSender, bytes32(uint256(uint160(user))));
        assertEq(proofZeroReceiverHash, sha256(bytes("alice.zero")));
        assertEq(proofCreatedAt, block.timestamp);
        assertEq(vm.load(address(bridge), bridge.requestProofSlot(requestHash, 0)), bytes32(pairId));
        assertEq(vm.load(address(bridge), bridge.requestProofSlot(requestHash, 1)), bytes32(uint256(1_000e6)));
        assertEq(vm.load(address(bridge), bridge.requestProofSlot(requestHash, 5)), bytes32(uint256(1)));
    }

    function testReleaseToEvmRequiresZeroBridgeAndIsIdempotent() public {
        vm.prank(user);
        bridge.depositToZero(pairId, 1_000e6, "alice.zero");

        bytes32 burnId = keccak256("zero-burn-1");

        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.NotZeroBridge.selector);
        bridge.releaseToEvm(pairId, 500e6, receiver, burnId, "alice.zero");

        vm.prank(zeroBridge);
        bridge.releaseToEvm(pairId, 500e6, receiver, burnId, "alice.zero");

        assertEq(usdc.balanceOf(receiver), 500e6);
        assertTrue(bridge.processedZeroBurns(burnId));

        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.ZeroBurnAlreadyProcessed.selector);
        bridge.releaseToEvm(pairId, 500e6, receiver, burnId, "alice.zero");
    }

    function testMintBurnPairMintsOnReleaseAndBurnsOnDeposit() public {
        BridgeMintBurnERC20 empires;
        uint256 empiresPairId;

        vm.startPrank(owner);
        empires = new BridgeMintBurnERC20("Wrapped EMPIRES", "wEMPIRES", 4, owner);
        empiresPairId = registry.addMintBurnPair(
            address(empires), 4, keccak256("EMPIRES:empires.zero"), 4, 1_0000, 1_000_000_0000, 5_000_000_0000
        );
        empires.setBridge(address(bridge));
        vm.stopPrank();

        bytes32 burnId = keccak256("empires-zero-burn-1");

        vm.prank(zeroBridge);
        bridge.releaseToEvm(empiresPairId, 10_0000, receiver, burnId, "alice.zero");

        assertEq(empires.balanceOf(receiver), 10_0000);
        assertEq(empires.totalSupply(), 10_0000);

        vm.prank(receiver);
        empires.approve(address(bridge), type(uint256).max);

        vm.prank(receiver);
        uint256 requestId = bridge.depositToZero(empiresPairId, 3_0000, "alice.zero");

        (,,,,,, bytes32 requestHash) = bridge.evmToZeroRequests(requestId);
        (
            uint256 proofPairId,
            uint256 proofAmount,
            bytes32 proofSender,
            bytes32 proofZeroReceiverHash,
            uint256 proofCreatedAt,
            bool proofExists
        ) = bridge.requestProofs(requestHash);

        assertEq(requestId, 1);
        assertEq(empires.balanceOf(receiver), 7_0000);
        assertEq(empires.balanceOf(address(bridge)), 0);
        assertEq(empires.totalSupply(), 7_0000);
        assertTrue(proofExists);
        assertEq(proofPairId, empiresPairId);
        assertEq(proofAmount, 3_0000);
        assertEq(proofSender, bytes32(uint256(uint160(receiver))));
        assertEq(proofZeroReceiverHash, sha256(bytes("alice.zero")));
        assertEq(proofCreatedAt, block.timestamp);
    }

    function testPairPauseStopsDepositsAndReleases() public {
        vm.prank(user);
        bridge.depositToZero(pairId, 1_000e6, "alice.zero");

        vm.prank(owner);
        registry.setPairActive(pairId, false);

        vm.prank(user);
        vm.expectRevert(BridgeRegistry.PairInactive.selector);
        bridge.depositToZero(pairId, 1_000e6, "alice.zero");

        vm.prank(zeroBridge);
        vm.expectRevert(BridgeRegistry.PairInactive.selector);
        bridge.releaseToEvm(pairId, 500e6, receiver, keccak256("burn"), "alice.zero");
    }

    function testGlobalPauseStopsDepositsAndReleases() public {
        vm.prank(user);
        bridge.depositToZero(pairId, 1_000e6, "alice.zero");

        vm.prank(owner);
        bridge.setPaused(true);

        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.BridgePaused.selector);
        bridge.depositToZero(pairId, 1_000e6, "alice.zero");

        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.BridgePaused.selector);
        bridge.releaseToEvm(pairId, 500e6, receiver, keccak256("burn"), "alice.zero");
    }

    function testLimitsAreEnforced() public {
        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.InvalidAmount.selector);
        bridge.depositToZero(pairId, 1e6 - 1, "alice.zero");

        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.InvalidAmount.selector);
        bridge.depositToZero(pairId, 10_000e6 + 1, "alice.zero");

        vm.prank(owner);
        registry.setPairLimits(pairId, 1e6, 10_000e6, 10_000e6);

        vm.prank(user);
        bridge.depositToZero(pairId, 6_000e6, "alice.zero");

        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.DailyLimitExceeded.selector);
        bridge.depositToZero(pairId, 5_000e6, "alice.zero");
    }
}
