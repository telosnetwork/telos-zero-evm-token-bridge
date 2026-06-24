// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract ReentrancyGuard {
    error ReentrantCall();

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private status = NOT_ENTERED;

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        if (status == ENTERED) revert ReentrantCall();
        status = ENTERED;
    }

    function _nonReentrantAfter() private {
        status = NOT_ENTERED;
    }
}
