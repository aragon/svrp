/*
 * SPDX-License-Identitifer:    GPL-3.0-or-later
 */

pragma solidity 0.4.24;

import "./lib/ECDSA.sol";
import "@aragon/evm-storage-proofs/contracts/lib/RLP.sol";

library SVRPProof {
    using RLP for bytes;
    using RLP for RLP.RLPItem;
    using ECDSA for bytes32;

    uint256 public constant VOTE_MESSAGE_LENGTH = 5; // 5 items - 88 bytes

    function equal(bytes _proof, bytes32 _anotherProofHash) internal pure returns (bool) {
        return keccak256(_proof) == _anotherProofHash;
    }

    function isValidIndex(bytes _proof, uint256 _index) internal pure returns (bool) {
        return _index < _proof.toRLPItem().numItems();
    }

    function isValidVote(bytes _proof, uint256 _index) internal pure returns (bool) {
        // return true if vote has the expected amount of items
        RLP.RLPItem memory voteRLP = votes(_proof)[_index];
        return voteRLP.numItems() == VOTE_MESSAGE_LENGTH;
    }

    function votes(bytes _proof) internal pure returns (RLP.RLPItem[] memory) {
        return _proof.toRLPItem().toList();
    }

    function voteAt(bytes _proof, uint256 _index) internal pure returns (RLP.RLPItem[] memory) {
        return votes(_proof)[_index].toList();
    }

    function isValidVote(RLP.RLPItem[] memory _votes, uint256 _index) internal pure returns (bool) {
        // return false if item is not a list;
        RLP.RLPItem memory voteRLP = _votes[_index];
        return voteRLP.numItems() == VOTE_MESSAGE_LENGTH;
    }

    function voteAt(RLP.RLPItem[] memory _votes, uint256 _index) internal pure returns (RLP.RLPItem[] memory) {
        return _votes[_index].toList();
    }

    function votingId(RLP.RLPItem[] memory _vote) internal pure returns (bytes4 _id) {
        bytes memory _votingId = _vote[0].toBytes();
        assembly { _id := mload(add(_votingId, 32)) }
    }

    function voteId(RLP.RLPItem[] memory _vote) internal pure returns (uint256) {
        return _vote[1].toUint();
    }

    function supports(RLP.RLPItem[] memory _vote) internal pure returns (bool) {
        return _vote[2].toBoolean();
    }

    function stake(RLP.RLPItem[] memory _vote) internal pure returns (uint256) {
        return _vote[3].toUint();
    }

    function signature(RLP.RLPItem[] memory _vote) internal pure returns (bytes) {
        return _vote[4].toBytes();
    }

    function voter(RLP.RLPItem[] memory _vote) internal pure returns (address) {
        return hash(_vote).toEthSignedMessageHash().recover(signature(_vote));
    }

    function hash(RLP.RLPItem[] memory _vote) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(votingId(_vote), voteId(_vote), supports(_vote), stake(_vote)));
    }

    function belongsTo(RLP.RLPItem[] memory _vote, bytes4 _votingId, uint256 _voteId) internal pure returns (bool) {
        return votingId(_vote) == _votingId && voteId(_vote) == _voteId;
    }
}
