const { votingIdentifier, voteHash } = require('./identifiers')

const sign = web3 => async (signer, messageHex = '0x') => {
    return web3.eth.sign(messageHex, signer)
}

const signVote = web3 => async (holder, vote) => {
    const message = voteHash(vote)
    const signature = await sign(web3)(holder, message)

    const { votingAddress, voteId, supports, stake } = vote
    const votingId = votingIdentifier(votingAddress)

    return { votingId, voteId, supports, stake, holder, signature, message }
}

module.exports = web3 => ({
    sign: sign(web3),
    signVote: signVote(web3),
})
