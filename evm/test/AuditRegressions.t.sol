// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EvmEscrowBridgeTest} from "./EvmEscrowBridge.t.sol";
import {BridgeRegistry} from "../src/BridgeRegistry.sol";
import {EvmEscrowBridge} from "../src/EvmEscrowBridge.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {BridgeMintBurnERC20} from "../src/mocks/BridgeMintBurnERC20.sol";

contract FeeToken {
    mapping(address => uint256) public balanceOf;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount * 9 / 10;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount * 9 / 10;
        return true;
    }
}

contract AuditRegressionsTest is EvmEscrowBridgeTest {
    function testRejectsUnusableNativeNamesBeforeTakingTokens() public {
        string[7] memory invalid = ["", "ALICE!", "alice.", ".", "abcdefghijklm", "abcdefghijkljz", "alice zero"];
        for (uint256 i; i < invalid.length; i++) {
            vm.prank(user);
            vm.expectRevert(EvmEscrowBridge.InvalidReceiver.selector);
            bridge.depositToZero(pairId, 1e6, invalid[i]);
        }
        assertEq(usdc.balanceOf(address(bridge)), 0);
        vm.prank(user);
        bridge.depositToZero(pairId, 1e6, "abcdefghijklj");
    }

    function testRefundRequiresDepositorIntentAndAuthorizedNativeDispatch() public {
        vm.prank(user);
        bridge.depositToZero(pairId, 1e6, "alice");
        (,,,,,, bytes32 hash) = bridge.evmToZeroRequests(1);
        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.InvalidRequest.selector);
        bridge.refundDeposit(1, hash);
        vm.prank(receiver);
        vm.expectRevert(EvmEscrowBridge.NotRequestSender.selector);
        bridge.requestDepositRefund(1);
        vm.prank(user);
        bridge.requestDepositRefund(1);
        assertEq(bridge.requestProofStatus(hash), 2);
        (,,,,, bool exists) = bridge.requestProofs(hash);
        assertFalse(exists);
        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.NotZeroBridge.selector);
        bridge.refundDeposit(1, hash);
        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.InvalidRequest.selector);
        bridge.refundDeposit(2, hash);
        vm.prank(zeroBridge);
        bridge.refundDeposit(1, hash);
        assertEq(bridge.requestProofStatus(hash), 3);
        assertEq(usdc.balanceOf(user), 100_000e6);
        assertEq(usdc.balanceOf(address(bridge)), 0);
        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.InvalidRequest.selector);
        bridge.refundDeposit(1, hash);
    }

    function testRecoveryAvailableWhilePaused() public {
        vm.prank(user);
        bridge.depositToZero(pairId, 1e6, "alice");
        (,,,,,, bytes32 hash) = bridge.evmToZeroRequests(1);
        vm.prank(owner);
        bridge.setPaused(true);
        vm.prank(owner);
        registry.setPairActive(pairId, false);
        vm.prank(user);
        bridge.requestDepositRefund(1);
        vm.prank(zeroBridge);
        bridge.refundDeposit(1, hash);
        assertEq(usdc.balanceOf(user), 100_000e6);
    }

    function testReleaseDailyCapAndNextDayReset() public {
        usdc.mint(address(bridge), 100_000e6);
        for (uint256 i; i < 5; i++) {
            vm.prank(zeroBridge);
            bridge.releaseToEvm(pairId, 10_000e6, receiver, bytes32(i + 1), "alice");
        }
        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.DailyLimitExceeded.selector);
        bridge.releaseToEvm(pairId, 1e6, receiver, bytes32(uint256(6)), "alice");
        assertFalse(bridge.processedZeroBurns(bytes32(uint256(6))));
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        vm.prank(zeroBridge);
        bridge.releaseToEvm(pairId, 1e6, receiver, bytes32(uint256(6)), "alice");
    }

    function testRejectsFeeOnTransferAndRollsBackDeposit() public {
        FeeToken token = new FeeToken();
        vm.prank(owner);
        uint256 id = registry.addPair(address(token), 6, keccak256("ZFEE"), 6, 1e6, 100e6, 100e6);
        token.mint(user, 100e6);
        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.UnsupportedTokenBehavior.selector);
        bridge.depositToZero(id, 100e6, "alice");
        assertEq(token.balanceOf(user), 100e6);
        assertEq(token.balanceOf(address(bridge)), 0);
        assertEq(bridge.nextRequestId(), 1);
        token.mint(address(bridge), 100e6);
        bytes32 burn = keccak256("fee-release");
        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.UnsupportedTokenBehavior.selector);
        bridge.releaseToEvm(id, 100e6, receiver, burn, "alice");
        assertFalse(bridge.processedZeroBurns(burn));
        assertEq(bridge.dailyReleases(id, block.timestamp / 1 days), 0);
        assertEq(token.balanceOf(address(bridge)), 100e6);
        assertEq(token.balanceOf(receiver), 0);
    }

    function testPairRequiresCodeAndCorrectDecimals() public {
        vm.startPrank(owner);
        vm.expectRevert(BridgeRegistry.InvalidToken.selector);
        registry.addPair(address(0x777), 6, keccak256("ZBAD"), 6, 1, 10, 10);
        vm.expectRevert(BridgeRegistry.InvalidDecimals.selector);
        registry.addPair(address(usdc), 8, keccak256("ZBAD"), 6, 1, 10, 10);
        vm.expectRevert(BridgeRegistry.InvalidDecimals.selector);
        registry.addPair(address(usdc), 6, keccak256("ZBAD"), 19, 1, 10, 10);
        vm.stopPrank();
    }

    function testUnequalDecimalsRejectDustAndKeepExactAmount() public {
        MockERC20 token = new MockERC20("Precision", "PREC", 8);
        vm.prank(owner);
        uint256 id = registry.addPair(address(token), 8, keccak256("ZPREC"), 6, 1, 100e8, 100e8);
        token.mint(user, 100e8);
        vm.prank(user);
        token.approve(address(bridge), type(uint256).max);
        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.InvalidAmount.selector);
        bridge.depositToZero(id, 101, "alice");
        vm.prank(user);
        uint256 number = bridge.depositToZero(id, 1e8, "alice");
        (,,,,,, bytes32 hash) = bridge.evmToZeroRequests(number);
        (, uint256 amount,,,,) = bridge.requestProofs(hash);
        assertEq(amount, 1e8);
    }

    function testRejectsAmountsOutsideNativeRange() public {
        MockERC20 token = new MockERC20("Precision", "PREC", 6);
        vm.prank(owner);
        uint256 id =
            registry.addPair(address(token), 6, keccak256("ZPREC"), 18, 1, type(uint128).max, type(uint128).max);
        vm.prank(user);
        vm.expectRevert(EvmEscrowBridge.InvalidAmount.selector);
        bridge.depositToZero(id, 1e9, "alice");
    }

    function testReplayStorageSlotRemainsCompatible() public {
        usdc.mint(address(bridge), 1e6);
        bytes32 burn = keccak256("slot-check");
        vm.prank(zeroBridge);
        bridge.releaseToEvm(pairId, 1e6, receiver, burn, "alice");
        assertEq(vm.load(address(bridge), keccak256(abi.encode(burn, uint256(6)))), bytes32(uint256(1)));
    }

    function testMintBurnCancellationRestoresBurnedSupplyExactlyOnce() public {
        vm.startPrank(owner);
        BridgeMintBurnERC20 token = new BridgeMintBurnERC20("Wrapped", "WRAP", 4, owner);
        uint256 id = registry.addMintBurnPair(address(token), 4, keccak256("WRAP"), 4, 1, 100_0000, 100_0000);
        token.setBridge(address(bridge));
        vm.stopPrank();
        vm.prank(zeroBridge);
        bridge.releaseToEvm(id, 10_0000, user, keccak256("original-burn"), "alice");
        vm.startPrank(user);
        token.approve(address(bridge), type(uint256).max);
        bridge.depositToZero(id, 3_0000, "alice");
        bridge.requestDepositRefund(1);
        vm.stopPrank();
        assertEq(token.totalSupply(), 7_0000);
        (,,,,,, bytes32 hash) = bridge.evmToZeroRequests(1);
        vm.prank(zeroBridge);
        bridge.refundDeposit(1, hash);
        assertEq(token.totalSupply(), 10_0000);
        assertEq(token.balanceOf(user), 10_0000);
        vm.prank(zeroBridge);
        vm.expectRevert(EvmEscrowBridge.InvalidRequest.selector);
        bridge.refundDeposit(1, hash);
    }
}
