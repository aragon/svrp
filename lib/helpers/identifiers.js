const { sha3, soliditySha3 } = require('web3-utils')

function votingIdentifier(address) {
    const hash = sha3(address, { encoding: 'hex' });
    return hash.substring(0, 10) // 0x + 4 bytes
}

function voteHash({ votingAddress, voteId, supports, stake }) {
    const voting = votingIdentifier(votingAddress)
    return soliditySha3(voting, voteId, supports, stake)
}

module.exports = {
    votingIdentifier,
    voteHash
}
