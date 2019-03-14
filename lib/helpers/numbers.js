module.exports = web3 => {
    const bn = x => new web3.utils.BN(x)
    const pct = x => bigExp(x, 16)
    const stake = x => bigExp(x, 18)
    const bigExp = (x, y) => bn(x).mul(bn(10).pow(bn(y)))

    return {
        bn,
        pct,
        stake,
        bigExp,
    }
}
