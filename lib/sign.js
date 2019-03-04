const SVRP = require('./SVRP')

const sign = web3 => (signer, messageHex = '0x') => {
    return web3.eth.sign(signer, messageHex)
}

const signVote = web3 => (holder, vote) => {
    const message = SVRP.hashMessage(vote)
    const signature = sign(web3)(holder, message)
    return { ...vote, holder, message, signature }
}

module.exports = web3 => ({
    sign: sign(web3),
    signVote: signVote(web3),
})
