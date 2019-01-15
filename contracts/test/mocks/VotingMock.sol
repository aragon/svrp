pragma solidity 0.4.24;

import "../../Voting.sol";


contract VotingMock is Voting {
    /* Ugly hack to work around this issue:
     * https://github.com/trufflesuite/truffle/issues/569
     * https://github.com/trufflesuite/truffle/issues/737
     */
    function newVoteExt(bytes _executionScript, string _metadata) external returns (uint256 voteId) {
        voteId = _newVote(_executionScript, _metadata);
        emit StartVote(voteId, msg.sender, _metadata);
    }

    // _isValuePct public wrapper
    function isValuePct(uint256 _value, uint256 _total, uint256 _pct) external pure returns (bool) {
        return _isValuePct(_value, _total, _pct);
    }
}
