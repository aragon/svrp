const { sign } = require('../../../lib/helpers/sign')(web3)
const { stake } = require('../../../lib/helpers/numbers')(web3)
const { voteHash } = require('../../../lib/helpers/identifiers')

const ECDSAMock = artifacts.require('ECDSAMock')

contract('ECDSA', function ([_, someone, anotherAddress]) {
    const MESSAGE = voteHash({ votingAddress: anotherAddress, voteId: 1, stake: stake(15), supports: true })

    beforeEach(async function () {
        this.ecdsa = await ECDSAMock.new()
    })

    context('with correct signature', function () {
        it('returns the signer address', async function () {
            const signature = await sign(someone, MESSAGE)

            assert.equal(await this.ecdsa.recover(MESSAGE, signature), someone)
        })
    })

    context('with wrong signature', function () {
        it('does not return the signer address', async function () {
            const signature = await sign(someone, MESSAGE)

            assert.notEqual(await this.ecdsa.recover('0xdead', signature), someone)
        })
    })
})
