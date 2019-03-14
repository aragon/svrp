pragma solidity ^0.4.24;

import "../../Voting.sol";
import "./TimeHelpersMock.sol";


contract VotingMock is Voting, TimeHelpersMock {
    // _isValuePct public wrapper
    function isValuePct(uint256 _value, uint256 _total, uint256 _pct) external pure returns (bool) {
        return _isValuePct(_value, _total, _pct);
    }
}
