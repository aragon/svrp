const SVRP = require('./SVRP')

function sign(signer, messageHex = '0x') {
    return web3.eth.sign(signer, messageHex)
}

function signVote(holder, vote) {
    const message = SVRP.hashMessage(vote)
    const signature = sign(holder, message)
    return { ...vote, message, signature }
}

module.exports = {
    sign,
    signVote
}
