// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

library SafeTransferLib {
    error SafeTransferFailed();
    error SafeTransferFromFailed();

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert SafeTransferFailed();
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert SafeTransferFromFailed();
    }
}
