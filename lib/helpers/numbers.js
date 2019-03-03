const { BN } = require('web3-utils')

const bn = x => new BN(x)
const pct = x => bigExp(x, 16)
const stake = x => bigExp(x, 18)
const bigExp = (x, y) => bn(x).mul(bn(10).pow(bn(y)))

module.exports = {
    bn,
    pct,
    stake,
    bigExp,
}
