pragma solidity ^0.4.24;


import "@aragon/os/contracts/common/TimeHelpers.sol";

contract TimeHelpersMock is TimeHelpers {
    uint256 mockedTimestamp;
    uint256 mockedBlockNumber;

    /**
    * @dev Sets a mocked timestamp value, used only for testing purposes
    */
    function increaseTime(uint256 _seconds) public {
        if (mockedTimestamp != 0) mockedTimestamp += _seconds;
        else mockedTimestamp = block.timestamp + _seconds;
    }

    /**
    * @dev Sets a mocked block number value, used only for testing purposes
    */
    function advanceBlocks(uint256 _number) public {
        if (mockedBlockNumber != 0) mockedBlockNumber += _number;
        else mockedBlockNumber = block.number + _number;
    }

    /**
    * @dev Returns the mocked timestamp if it was set, or current `block.timestamp`
    */
    function getTimestamp() internal view returns (uint256) {
        if (mockedTimestamp != 0) return mockedTimestamp;
        return super.getTimestamp();
    }

    /**
    * @dev Returns the mocked block number if it was set, or current `block.number`
    */
    function getBlockNumber() internal view returns (uint256) {
        if (mockedBlockNumber != 0) return mockedBlockNumber;
        return super.getBlockNumber();
    }
}
