const BN = web3.BigNumber
const RLP = require('rlp')
const SVRP = require('../../lib/SVRP')
const { sign } = require('../../lib/sign')(web3)
const { soliditySha3 } = require('web3-utils')

contract('SVRP', ([voter1, voter2, voter3, voter4, votingAddress, anotherVotingAddress]) => {
    const MESSAGE = soliditySha3('SVRP')

    describe('encode', function () {
        context('with a single vote', function () {
            const vote = { votingAddress, voteId: 1, stake: new BN('15e18'), supports: true, signature: sign(voter1, MESSAGE) }

            it('encodes the votes as a buffer by default', function () {
                const encode = SVRP.encode([vote])
                const decodedData = RLP.decode(encode)

                assert(decodedData.length === 1)
                assertVote(decodedData[0], vote)
            })

            it('encodes the votes in hex encoding', function () {
                const encode = SVRP.encode([vote], 'hex')
                const decodedData = RLP.decode(Buffer.from(encode, 'hex'))

                assert(decodedData.length === 1)
                assertVote(decodedData[0], vote)
            })
        })

        context('with multiple votes', function () {
            const vote1 = { votingAddress, voteId: 1, stake: new BN('15e18'), supports: true, signature: sign(voter1, MESSAGE) }
            const vote2 = { votingAddress, voteId: 256, stake: new BN('15'), supports: true, signature: sign(voter2, MESSAGE) }
            const vote3 = { votingAddress, voteId: 82913, stake: new BN('1243e18'), supports: false, signature: sign(voter3, MESSAGE) }
            const vote4 = { votingAddress: anotherVotingAddress, voteId: 256, stake: new BN('15e18'), supports: false, signature: sign(voter4, MESSAGE) }

            it('encodes it properly', function () {
                const encode = SVRP.encode([vote1, vote2, vote3, vote4])
                const decodedData = RLP.decode(encode)

                assert(decodedData.length === 4)
                assertVote(decodedData[0], vote1)
                assertVote(decodedData[1], vote2)
                assertVote(decodedData[2], vote3)
                assertVote(decodedData[3], vote4)
            })
        })
    })

    function assertVote(data, vote) {
        const expectedVotingId = data[0].toString('hex')
        const expectedVoteId = parseInt(`0x${data[1].toString('hex')}`)
        const expectedSupport = parseInt(`0x${data[2].toString('hex')}`)
        const expectedStake = new BN(`0x${data[3].toString('hex')}`)
        const expectedSignature = `0x${data[4].toString('hex')}`

        assert(vote.votingAddress.substring(2, 10), expectedVotingId)
        assert(vote.voteId, expectedVoteId)
        assert((vote.supports && expectedSupport === 1) || (!vote.supports && expectedSupport === 0))
        assert(vote.stake.eq(expectedStake))
        assert(vote.signature, expectedSignature)
    }
})
