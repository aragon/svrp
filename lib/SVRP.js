const RLP = require('rlp')
const { sha3, soliditySha3 } = require('web3-utils')

const PROPOSAL_BYTES_LENGTH = 3
const CASTED_VOTE_BYTES_LENGTH = 1
const VOTER_BALANCE_BYTES_LENGTH = 16
const VOTER_SIGNATUREE_BYTES_LENGTH = 65

module.exports = {
    /**
     * Encodes a batch of votes messages
     * @param votesData - array of objects with keys `votingAddress`, `votingId`, `supports`, `stake` and `signature`
     * @param format - string denoting the encoding format
     * @returns Buffer|String - the buffer of RLP encoded data
     */
    encode(votesData, format = undefined) {
        const payloads = votesData.map(voteData => this._buildPayload(voteData))
        // console.log(`Encoding payload: \n - ${payloads.join('\n - ')}`)
        const result = RLP.encode(payloads);
        return format ? result.toString(format) : result
    },

    hashMessage(voteData) {
        const { voteId, supports, stake } = voteData
        const votingId = this._votingIdentifier(voteData.votingAddress)
        return soliditySha3(votingId, voteId, supports, stake.toString())
    },

    buildRawMessage(voteData) {
        const votingId = this._votingIdentifier(voteData.votingAddress)
        const voteId = this._numberToHex(voteData.voteId, PROPOSAL_BYTES_LENGTH)
        const supports = this._numberToHex(voteData.supports ? 1 : 0, CASTED_VOTE_BYTES_LENGTH)
        const stake = this._numberToHex(voteData.stake, VOTER_BALANCE_BYTES_LENGTH)
        return [votingId, voteId, supports, stake]
    },

    _buildPayload(voteData) {
        const signature = voteData.signature.substring(0, VOTER_SIGNATUREE_BYTES_LENGTH * 2 + 2) // 0x + 65 bytes
        return [...this.buildRawMessage(voteData), signature]
    },

    _votingIdentifier(address) {
        const hash = sha3(address, { encoding: 'hex' });
        return hash.substring(0, 10) // 0x + 4 bytes
    },

    _numberToHex(number, length) {
        const hex = number.toString(16)
        return '0x' + '0'.repeat(length * 2 - hex.length) + hex
    }
}
