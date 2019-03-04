const BN = web3.BigNumber
const SVRP = require('../../../lib/SVRP')
const { sign } = require('../../../lib/sign')(web3)

const ECDSAMock = artifacts.require('ECDSAMock')

contract('ECDSA', function ([_, someone, anotherAddress]) {
    const MESSAGE = SVRP.hashMessage({ votingAddress: anotherAddress, voteId: 1, stake: new BN('15e18'), supports: true })

    beforeEach(async function () {
        this.ecdsa = await ECDSAMock.new()
    })

    context('with correct signature', function () {
        it('returns the signer address', async function () {
            const signature = sign(someone, MESSAGE)

            assert.equal(await this.ecdsa.recover(MESSAGE, signature), someone)
        })
    })

    context('with wrong signature', function () {
        it('does not return the signer address', async function () {
            const signature = sign(someone, MESSAGE)

            assert.notEqual(await this.ecdsa.recover('bla', signature), someone)
        })
    })
})
