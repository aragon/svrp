/*
 * SPDX-License-Identitifer:    GPL-3.0-or-later
 */

pragma solidity 0.4.24;

import "./lib/RLP.sol";
import "./SVRPProof.sol";

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/common/IForwarder.sol";
import "@aragon/os/contracts/lib/token/ERC20.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/math/SafeMath64.sol";
import "@aragon/apps-shared-minime/contracts/MiniMeToken.sol";

contract Voting is IForwarder, AragonApp {
    using SafeMath for uint256;
    using SafeMath64 for uint64;
    using SVRPProof for bytes;
    using SVRPProof for RLP.RLPItem[];

    bytes32 public constant CREATE_VOTES_ROLE = keccak256("CREATE_VOTES_ROLE");
    bytes32 public constant SUBMIT_BATCH_ROLE = keccak256("SUBMIT_BATCH_ROLE");
    bytes32 public constant MODIFY_SUPPORT_ROLE = keccak256("MODIFY_SUPPORT_ROLE");
    bytes32 public constant MODIFY_QUORUM_ROLE = keccak256("MODIFY_QUORUM_ROLE");

    uint64 public constant PCT_BASE = 10 ** 18; // 0% = 0; 1% = 10^16; 100% = 10^18
    uint256 public constant CHALLENGE_WINDOW = 7 days;

    string private constant ERROR_NO_VOTE = "VOTING_NO_VOTE";
    string private constant ERROR_NO_BATCH = "VOTING_NO_BATCH";
    string private constant ERROR_INIT_PCTS = "VOTING_INIT_PCTS";
    string private constant ERROR_CHANGE_SUPPORT_PCTS = "VOTING_CHANGE_SUPPORT_PCTS";
    string private constant ERROR_CHANGE_QUORUM_PCTS = "VOTING_CHANGE_QUORUM_PCTS";
    string private constant ERROR_INIT_SUPPORT_TOO_BIG = "VOTING_INIT_SUPPORT_TOO_BIG";
    string private constant ERROR_CHANGE_SUPPORT_TOO_BIG = "VOTING_CHANGE_SUPP_TOO_BIG";
    string private constant ERROR_CAN_NOT_SUBMIT_BATCH = "VOTING_CAN_NOT_SUBMIT_BATCH";
    string private constant ERROR_CAN_NOT_EXECUTE = "VOTING_CAN_NOT_EXECUTE";
    string private constant ERROR_CAN_NOT_FORWARD = "VOTING_CAN_NOT_FORWARD";
    string private constant ERROR_NO_VOTING_POWER = "VOTING_NO_VOTING_POWER";
    string private constant ERROR_CHALLENGE_REJECTED = "VOTING_CHALLENGE_REJECTED";
    string private constant ERROR_OUT_OF_BATCH_CHALLENGE_PERIOD = "VOTING_OUT_OF_CHALLENGE_PERIOD";

    struct Vote {
        bool executed;
        uint64 startDate;
        uint64 snapshotBlock;
        uint64 supportRequiredPct;
        uint64 minAcceptQuorumPct;
        uint256 yea;
        uint256 nay;
        uint256 votingPower;
        bytes executionScript;
        mapping (uint256 => Batch) batches;
        uint256 batchesLength;
    }

    struct Batch {
        bool valid;
        uint256 yea;
        uint256 nay;
        bytes32 proofHash;
        uint256 timestamp;
    }

    MiniMeToken public token;
    ERC20 public collateralToken;
    uint64 public supportRequiredPct;
    uint64 public minAcceptQuorumPct;
    uint64 public voteTime;
    uint256 public slashingCost;

    // We are mimicing an array, we use a mapping instead to make app upgrade more graceful
    mapping (uint256 => Vote) internal votes;
    uint256 public votesLength;

    event StartVote(uint256 indexed voteId, address indexed creator, string metadata);
    event SubmitBatch(uint256 indexed voteId, uint256 indexed batchId, bytes proof, uint256 yea, uint256 nay);
    event ExecuteVote(uint256 indexed voteId);
    event ChangeSupportRequired(uint64 supportRequiredPct);
    event ChangeMinQuorum(uint64 minAcceptQuorumPct);
    event InvalidProof(uint256 indexed voteId, uint256 indexed batchId, bytes proof);
    event InvalidVote(uint256 indexed voteId, uint256 indexed batchId, bytes proof, uint256 voteIndex);
    event InvalidAggregation(uint256 indexed voteId, uint256 indexed batchId, bytes proof);
    event InvalidVoteStake(uint256 indexed voteId, uint256 indexed batchId, bytes proof, uint256 voteIndex);
    event VoteDuplication(uint256 indexed voteId, uint256 indexed batchId, bytes proof, uint256 voteIndex);

    modifier voteExists(uint256 _voteId) {
        require(_existsVote(_voteId), ERROR_NO_VOTE);
        _;
    }

    modifier batchExists(uint256 _voteId, uint256 _batchId) {
        require(_existsBatch(_voteId, _batchId), ERROR_NO_BATCH);
        _;
    }

    /**
    * @notice Initialize Voting app with `_token.symbol(): string` for governance, minimum support of `@formatPct(_supportRequiredPct)`%, minimum acceptance quorum of `@formatPct(_minAcceptQuorumPct)`%, and a voting duration of `@transformTime(_voteTime)`
    * @param _token MiniMeToken Address that will be used as governance token
    * @param _supportRequiredPct Percentage of yeas in casted votes for a vote to succeed (expressed as a percentage of 10^18; eg. 10^16 = 1%, 10^18 = 100%)
    * @param _minAcceptQuorumPct Percentage of yeas in total possible votes for a vote to succeed (expressed as a percentage of 10^18; eg. 10^16 = 1%, 10^18 = 100%)
    * @param _voteTime Seconds that a vote will be open for token holders to vote (unless enough yeas or nays have been cast to make an early decision)
    */
    function initialize(
        MiniMeToken _token,
        ERC20 _collateralToken,
        uint64 _supportRequiredPct,
        uint64 _minAcceptQuorumPct,
        uint64 _voteTime,
        uint256 _slashingCost
    )
        external
        onlyInit
    {
        initialized();

        require(_minAcceptQuorumPct <= _supportRequiredPct, ERROR_INIT_PCTS);
        require(_supportRequiredPct < PCT_BASE, ERROR_INIT_SUPPORT_TOO_BIG);

        token = _token;
        collateralToken = _collateralToken;
        supportRequiredPct = _supportRequiredPct;
        minAcceptQuorumPct = _minAcceptQuorumPct;
        voteTime = _voteTime;
        slashingCost = _slashingCost;
    }

    /**
    * @notice Change required support to `@formatPct(_supportRequiredPct)`%
    * @param _supportRequiredPct New required support
    */
    function changeSupportRequiredPct(uint64 _supportRequiredPct)
        external
        authP(MODIFY_SUPPORT_ROLE, arr(uint256(_supportRequiredPct), uint256(supportRequiredPct)))
    {
        require(minAcceptQuorumPct <= _supportRequiredPct, ERROR_CHANGE_SUPPORT_PCTS);
        require(_supportRequiredPct < PCT_BASE, ERROR_CHANGE_SUPPORT_TOO_BIG);
        supportRequiredPct = _supportRequiredPct;

        emit ChangeSupportRequired(_supportRequiredPct);
    }

    /**
    * @notice Change minimum acceptance quorum to `@formatPct(_minAcceptQuorumPct)`%
    * @param _minAcceptQuorumPct New acceptance quorum
    */
    function changeMinAcceptQuorumPct(uint64 _minAcceptQuorumPct)
        external
        authP(MODIFY_QUORUM_ROLE, arr(uint256(_minAcceptQuorumPct), uint256(minAcceptQuorumPct)))
    {
        require(_minAcceptQuorumPct <= supportRequiredPct, ERROR_CHANGE_QUORUM_PCTS);
        minAcceptQuorumPct = _minAcceptQuorumPct;

        emit ChangeMinQuorum(_minAcceptQuorumPct);
    }

    /**
    * @notice Create a new vote about "`_metadata`"
    * @param _executionScript EVM script to be executed on approval
    * @param _metadata Vote metadata
    * @return voteId Id for newly created vote
    */
    function newVote(bytes _executionScript, string _metadata) external auth(CREATE_VOTES_ROLE) returns (uint256 voteId) {
        return _newVote(_executionScript, _metadata);
    }

    /**
    * @notice Submit new batch of casted votes for a voteId
    */
    function submitBatch(uint256 _voteId, uint256 _yeas, uint256 _nays, bytes _proof)
        external
        auth(SUBMIT_BATCH_ROLE)
        voteExists(_voteId)
    {
        require(canSubmit(_voteId), ERROR_CAN_NOT_SUBMIT_BATCH);
        _submitBatch(_voteId, _yeas, _nays, _proof);
    }

    /**
    * @notice Challenge batch for invalid aggregation
    */
    function challengeAggregation(uint256 _voteId, uint256 _batchId, bytes _proof) external batchExists(_voteId, _batchId) {
        Batch storage batch_ = votes[_voteId].batches[_batchId];

        require(_proof.equal(batch_.proofHash), ERROR_CHALLENGE_REJECTED);
        require(_withinChallengeWindow(batch_), ERROR_OUT_OF_BATCH_CHALLENGE_PERIOD);

        (bool invalidVote, uint256 voteIndex, bool invalidAggregation) = _isInvalidAggregation(_voteId, _batchId, _proof);

        if (invalidVote) {
            emit InvalidVote(_voteId, _batchId, _proof, voteIndex);
            return _rollbackBatchAndPayOutReward(_voteId, _batchId, msg.sender);
        }
        if (invalidAggregation) {
            emit InvalidAggregation(_voteId, _batchId, _proof);
            return _rollbackBatchAndPayOutReward(_voteId, _batchId, msg.sender);
        }

        revert(ERROR_CHALLENGE_REJECTED);
    }

    /**
    * @notice Challenge batch for invalid vote
    */
    function challengeVoteStake(uint256 _voteId, uint256 _batchId, bytes _proof, uint256 _voteIndex) external batchExists(_voteId, _batchId) {
        Batch storage batch_ = votes[_voteId].batches[_batchId];

        require(_proof.equal(batch_.proofHash), ERROR_CHALLENGE_REJECTED);
        require(_proof.isValidIndex(_voteIndex), ERROR_CHALLENGE_REJECTED);
        require(_withinChallengeWindow(batch_), ERROR_OUT_OF_BATCH_CHALLENGE_PERIOD);

        if (_isInvalidVote(_voteId, _proof, _voteIndex)) {
            emit InvalidVote(_voteId, _batchId, _proof, _voteIndex);
            return _rollbackBatchAndPayOutReward(_voteId, _batchId, msg.sender);
        }
        if (_isInvalidStake(_voteId, _proof, _voteIndex)) {
            emit InvalidVoteStake(_voteId, _batchId, _proof, _voteIndex);
            return _rollbackBatchAndPayOutReward(_voteId, _batchId, msg.sender);
        }

        revert(ERROR_CHALLENGE_REJECTED);
    }

    /**
    * @notice Challenge batch for votes duplication
    */
    function challengeDuplication(uint256 _voteId, uint256 _previousBatchId, uint256 _currentBatchId, uint256 _previousVoteIndex, uint256 _currentVoteIndex, bytes _previousProof, bytes _currentProof) external batchExists(_voteId, _previousBatchId) batchExists(_voteId, _currentBatchId) {
        Batch storage currentBatch_ = votes[_voteId].batches[_currentBatchId];

        require(_previousBatchId != _currentBatchId, ERROR_CHALLENGE_REJECTED);
        require(_currentProof.equal(currentBatch_.proofHash), ERROR_CHALLENGE_REJECTED);
        require(_currentProof.isValidIndex(_currentVoteIndex), ERROR_CHALLENGE_REJECTED);
        require(_withinChallengeWindow(currentBatch_), ERROR_OUT_OF_BATCH_CHALLENGE_PERIOD);

        // must rollback on an invalid previous vote, cannot perform any checks with it :/
        require(_canVerifyBatch(_voteId, _previousBatchId, _previousProof, _previousVoteIndex), ERROR_CHALLENGE_REJECTED);

        if (_isInvalidVote(_voteId, _currentProof, _currentVoteIndex)) {
            emit InvalidVote(_voteId, _currentBatchId, _currentProof, _currentVoteIndex);
            return _rollbackBatchAndPayOutReward(_voteId, _currentBatchId, msg.sender);
        }
        if (_isDoubleVoting(_previousProof, _previousVoteIndex, _currentProof, _currentVoteIndex)) {
            // TODO: emit single event - this is a hack to avoid stack level too deep error
            emit VoteDuplication(_voteId, _previousBatchId, _previousProof, _previousVoteIndex);
            emit VoteDuplication(_voteId, _currentBatchId, _currentProof, _currentVoteIndex);
            return _rollbackBatchAndPayOutReward(_voteId, _currentBatchId, msg.sender);
        }

        revert(ERROR_CHALLENGE_REJECTED);
    }

    /**
    * @notice Execute vote #`_voteId`
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @param _voteId Id for vote
    */
    function executeVote(uint256 _voteId) external voteExists(_voteId) {
        require(canExecute(_voteId), ERROR_CAN_NOT_EXECUTE);
        _executeVote(_voteId);
    }

    function isForwarder() public pure returns (bool) {
        return true;
    }

    /**
    * @notice Creates a vote to execute the desired action, and casts a support vote if possible
    * @dev IForwarder interface conformance
    * @param _evmScript Start vote with script
    */
    function forward(bytes _evmScript) public {
        require(canForward(msg.sender, _evmScript), ERROR_CAN_NOT_FORWARD);
        _newVote(_evmScript, "");
    }

    function canForward(address _sender, bytes) public view returns (bool) {
        // Note that `canPerform()` implicitly does an initialization check itself
        return canPerform(_sender, CREATE_VOTES_ROLE, arr());
    }

    function canSubmit(uint256 _voteId) public view voteExists(_voteId) returns (bool) {
        Vote storage vote_ = votes[_voteId];
        bool isOpen = _isVoteOpen(_voteId);
        bool hasEnoughBalanceToPayChallenges = collateralToken.balanceOf(this) >= slashingCost.mul(vote_.batchesLength.add(1));
        return isOpen && hasEnoughBalanceToPayChallenges;
    }

    function canExecute(uint256 _voteId) public view voteExists(_voteId) returns (bool) {
        Vote storage vote_ = votes[_voteId];

        if (vote_.executed) {
            return false;
        }

        // Has challenge period ended?
        Batch storage batch_ = vote_.batches[vote_.batchesLength.sub(1)];
        if (_withinChallengeWindow(batch_)) {
            return false;
        }

        // Voting is already decided
        if (_isValuePct(vote_.yea, vote_.votingPower, vote_.supportRequiredPct)) {
            return true;
        }

        uint256 totalVotes = vote_.yea.add(vote_.nay);

        // Vote ended?
        if (_isVoteOpen(_voteId)) {
            return false;
        }
        // Has enough support?
        if (!_isValuePct(vote_.yea, totalVotes, vote_.supportRequiredPct)) {
            return false;
        }
        // Has min quorum?
        if (!_isValuePct(vote_.yea, vote_.votingPower, vote_.minAcceptQuorumPct)) {
            return false;
        }

        return true;
    }

    function getVote(uint256 _voteId)
        public
        view
        voteExists(_voteId)
        returns (
            bool open,
            bool executed,
            uint64 startDate,
            uint64 snapshotBlock,
            uint64 supportRequired,
            uint64 minAcceptQuorum,
            uint256 yea,
            uint256 nay,
            uint256 votingPower,
            bytes script
        )
    {
        Vote storage vote_ = votes[_voteId];
        open = _isVoteOpen(_voteId);
        executed = vote_.executed;
        startDate = vote_.startDate;
        snapshotBlock = vote_.snapshotBlock;
        supportRequired = vote_.supportRequiredPct;
        minAcceptQuorum = vote_.minAcceptQuorumPct;
        yea = vote_.yea;
        nay = vote_.nay;
        votingPower = vote_.votingPower;
        script = vote_.executionScript;
    }

    function getBatch(uint256 _voteId, uint256 _batchId)
        public
        view
        batchExists(_voteId, _batchId)
        returns (
            bool valid,
            uint256 yea,
            uint256 nay,
            uint256 timestamp,
            bytes32 proofHash
        )
    {
        Vote storage vote_ = votes[_voteId];
        Batch storage batch_ = vote_.batches[_batchId];
        yea = batch_.yea;
        nay = batch_.nay;
        valid = batch_.valid;
        proofHash = batch_.proofHash;
        timestamp = batch_.timestamp;
    }

    function _newVote(bytes _executionScript, string _metadata) internal returns (uint256 voteId) {
        uint256 votingPower = token.totalSupplyAt(vote_.snapshotBlock);
        require(votingPower > 0, ERROR_NO_VOTING_POWER);

        voteId = votesLength++;
        Vote storage vote_ = votes[voteId];
        vote_.startDate = getTimestamp64();
        vote_.snapshotBlock = getBlockNumber64() - 1; // avoid double voting in this very block
        vote_.supportRequiredPct = supportRequiredPct;
        vote_.minAcceptQuorumPct = minAcceptQuorumPct;
        vote_.votingPower = votingPower;
        vote_.executionScript = _executionScript;

        emit StartVote(voteId, msg.sender, _metadata);
    }

    function _submitBatch(uint256 _voteId, uint256 _yea, uint256 _nay, bytes _proof) internal {
        Vote storage vote_ = votes[_voteId];
        uint256 _batchId = vote_.batchesLength;
        bytes32 _proofHash = keccak256(_proof);

        Batch storage batch_ = vote_.batches[vote_.batchesLength];
        batch_.valid = true;
        batch_.yea = _yea;
        batch_.nay = _nay;
        batch_.proofHash = _proofHash;
        batch_.timestamp = block.timestamp;
        vote_.yea = vote_.yea.add(_yea);
        vote_.nay = vote_.nay.add(_nay);
        vote_.batchesLength = vote_.batchesLength.add(1);

        emit SubmitBatch(_voteId, _batchId, _proof, _yea, _nay);
    }

    function _executeVote(uint256 _voteId) internal {
        Vote storage vote_ = votes[_voteId];

        vote_.executed = true;

        // TODO: Consider input for voting scripts
        bytes memory input = new bytes(0);
        runScript(vote_.executionScript, input, new address[](0));

        emit ExecuteVote(_voteId);
    }

    function _isVoteOpen(uint256 _voteId) internal view returns (bool) {
        Vote storage vote_ = votes[_voteId];
        return getTimestamp64() < vote_.startDate.add(voteTime) && !vote_.executed;
    }

    /**
    * @dev Calculates whether `_value` is more than a percentage `_pct` of `_total`
    */
    function _isValuePct(uint256 _value, uint256 _total, uint256 _pct) internal pure returns (bool) {
        if (_total == 0) {
            return false;
        }

        uint256 computedPct = _value.mul(PCT_BASE) / _total;
        return computedPct > _pct;
    }

    function _withinChallengeWindow(Batch storage batch_) internal view returns (bool) {
        return batch_.timestamp + CHALLENGE_WINDOW >= now;
    }

    function _existsVote(uint256 _voteId) internal view returns (bool) {
        return _voteId < votesLength;
    }

    function _existsBatch(uint256 _voteId, uint256 _batchId) internal view returns (bool) {
        if (!_existsVote(_voteId)) return false;
        Vote storage vote_ = votes[_voteId];
        return _batchId < vote_.batchesLength;
    }

    function _rollbackBatchAndPayOutReward(uint256 _voteId, uint256 _batchId, address rewarded) internal {
        Vote storage vote_ = votes[_voteId];
        Batch storage batch_ = vote_.batches[_batchId];

        batch_.valid = false;
        vote_.yea = vote_.yea.sub(batch_.yea);
        vote_.nay = vote_.nay.sub(batch_.nay);
        require(collateralToken.transfer(rewarded, slashingCost));
    }

    /**
    * @dev Checks whether a vote of a given proof is valid or not
    * @return true if the given vote is not valid
    */
    function _isInvalidVote(uint256 _voteId, bytes _proof, uint256 _voteIndex) internal view returns (bool) {
        if (!_proof.isValidVote(_voteIndex)) return true;
        RLP.RLPItem[] memory vote = _proof.voteAt(_voteIndex);
        if (!vote.belongsTo(_identifier(), _voteId)) return true;
    }

    /**
    * @dev Checks whether a vote stake in a batch was valid or not
    * @return true if the given vote stake was incorrect
    */
    function _isInvalidStake(uint256 _voteId, bytes _proof, uint256 _voteIndex) internal view returns (bool) {
        RLP.RLPItem[] memory vote = _proof.voteAt(_voteIndex);
        address voter = vote.voter();
        uint256 voterBalance = token.balanceOfAt(voter, votes[_voteId].snapshotBlock);
        return voterBalance != vote.stake();
    }

    /**
    * @dev Checks whether a vote was included in two batches based on given proofs
    * @return true if the given proofs are valid and the vote was duplicated
    */
    function _isDoubleVoting(bytes _proof, uint256 _voteIndex, bytes _anotherProof, uint256 _anotherVoteIndex) internal pure returns (bool) {
        RLP.RLPItem[] memory vote = _proof.voteAt(_voteIndex);
        RLP.RLPItem[] memory anotherVote = _anotherProof.voteAt(_anotherVoteIndex);
        return vote.voter() == anotherVote.voter();
    }

    /**
    * @dev Checks whether a batch was aggregated correctly or not based on a given proof:
    * - Proof is well formed and can be decoded
    * - All votes must be unique within proof
    * - Tally of all votes adds up
    * @return true if the given proof is valid and the tally was incorrect
    */
    function _isInvalidAggregation(uint256 _voteId, uint256 _batchId, bytes _proof) internal view returns (bool invalidVote, uint256 invalidVoteIndex, bool invalidAggregation) {
        uint256 yeas;
        uint256 nays;
        RLP.RLPItem[] memory votes_ = _proof.votes();

        address previousAddress = address(0);
        for (uint256 i = 0; i < votes_.length; i++) {
            // returns invalid vote if item cannot be decoded or duplicated
            if (_isInvalidVote(_voteId, _proof, i)) return (true, i, false);
            RLP.RLPItem[] memory vote = votes_.voteAt(i);
            address voter = vote.voter();
            if (voter <= previousAddress) return (true, i, false);

            previousAddress = voter;

            if (vote.supports()) yeas = yeas.add(vote.stake());
            else nays = nays.add(vote.stake());
        }

        // returns valid vote and if tally totals don't add up
        Batch storage batch_ = votes[_voteId].batches[_batchId];
        return (false, 0, yeas != batch_.yea || nays != batch_.nay);
    }

    function _canVerifyBatch(uint256 _voteId, uint256 _batchId, bytes _proof, uint256 _voteIndex) internal view returns (bool) {
        Batch storage batch_ = votes[_voteId].batches[_batchId];
        if (!_proof.equal(batch_.proofHash)) return false;
        if (!_proof.isValidIndex(_voteIndex)) return false;
        if (_isInvalidVote(_voteId, _proof, _voteIndex)) return false;
        return true;
    }

    function _identifier() internal view returns (bytes4) {
        return bytes4(keccak256(abi.encodePacked(address(this))));
    }
}
