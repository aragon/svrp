const RLP = require('rlp')

const PROPOSAL_BYTES_LENGTH = 3
const CASTED_VOTE_BYTES_LENGTH = 1
const VOTER_BALANCE_BYTES_LENGTH = 16
const VOTER_SIGNATURE_BYTES_LENGTH = 65

module.exports = {
    /**
     * Encodes a batch of votes messages in hex format
     * @param votesData - array of objects with keys `votingId`, `voteId`, `supports`, `stake`, `signature`, `holder, and `message`
     * @returns String - RLP encoded data hex formatted
     */
    encodeHex(votesData) {
        return `0x${this.encode(votesData, 'hex')}`
    },

    /**
     * Encodes a batch of votes messages
     * @param votesData - array of objects with keys `votingId`, `voteId`, `supports`, `stake`, `signature`, `holder, and `message`
     * @param format - string denoting the encoding format
     * @returns Buffer|String - the buffer of RLP encoded data
     */
    encode(votesData, format = undefined) {
        const payloads = votesData.sort(this._sortVotes).map(v => this._buildPayload(v))
        const result = RLP.encode(payloads);
        return format ? result.toString(format) : result
    },

    _buildPayload(voteData) {
        const signature = voteData.signature.substring(0, VOTER_SIGNATURE_BYTES_LENGTH * 2 + 2) // 0x + 65 bytes
        return [...this._buildRawMessage(voteData), signature]
    },

    _buildRawMessage({ votingId, voteId, supports, stake }) {
	    const parsedVoteId = this._numberToHex(voteId, PROPOSAL_BYTES_LENGTH)
        const parsedSupports = this._numberToHex(supports ? 1 : 0, CASTED_VOTE_BYTES_LENGTH)
        const parsedStake = this._numberToHex(stake, VOTER_BALANCE_BYTES_LENGTH)
        return [votingId, parsedVoteId, parsedSupports, parsedStake]
    },

    _numberToHex(number, length) {
        const hex = number.toString(16)
        return '0x' + '0'.repeat(length * 2 - hex.length) + hex
    },

    _sortVotes({ holder }, { holder: anotherHolder }) {
        if (holder > anotherHolder) return 1
        if (holder < anotherHolder) return -1
        return 0
    }
}
