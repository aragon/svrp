const RLP = require('rlp')
const SVRP = require('../../lib/models/SVRP')
const { signVote } = require('../../lib/helpers/sign')(web3)
const { bn, stake } = require('../../lib/helpers/numbers')

contract('SVRP', ([voter1, voter2, voter3, voter4, votingAddress, anotherVotingAddress]) => {
    describe('encode', function () {
        context('with a single vote', function () {

            it('encodes the votes as a buffer by default', async function () {
                const vote = await signVote(voter1, { votingAddress, voteId: 1, stake: stake(15), supports: true })

                const encode = SVRP.encode([vote])
                const decodedData = RLP.decode(encode)

                assert(decodedData.length === 1)
                assertVote(decodedData[0], vote)
            })

            it('encodes the votes in hex encoding', async function () {
                const vote = await signVote(voter1, { votingAddress, voteId: 1, stake: stake(15), supports: true })

                const encode = SVRP.encode([vote], 'hex')
                const decodedData = RLP.decode(Buffer.from(encode, 'hex'))

                assert(decodedData.length === 1)
                assertVote(decodedData[0], vote)
            })
        })

        context('with multiple votes', function () {
            it('encodes it properly', async function () {
                const vote1 = await signVote(voter1, { votingAddress, voteId: 1, stake: stake(15), supports: true })
                const vote2 = await signVote(voter2, { votingAddress, voteId: 256, stake: bn(15), supports: true })
                const vote3 = await signVote(voter3, { votingAddress, voteId: 82913, stake: stake(1243), supports: false })
                const vote4 = await signVote(voter4, { votingAddress: anotherVotingAddress, voteId: 256, stake: stake(15), supports: false })

                const votes = [vote1, vote2, vote3, vote4]
                const encode = SVRP.encode(votes)
                const decodedData = RLP.decode(encode)

                assert(decodedData.length === 4)
                const sortedVotes = votes.sort(SVRP._sortVotes)
                for (const vote of sortedVotes) assertVote(decodedData[votes.indexOf(vote)], vote)
            })
        })
    })

    function assertVote(data, vote) {
        const expectedVotingId = `0x${data[0].toString('hex')}`
        const expectedVoteId = parseInt(`0x${data[1].toString('hex')}`)
        const expectedSupport = parseInt(`0x${data[2].toString('hex')}`)
        const expectedStake = bn(data[3], 16)
        const expectedSignature = `0x${data[4].toString('hex')}`

        assert.equal(vote.votingId, expectedVotingId)
        assert.equal(vote.voteId, expectedVoteId)
        assert((vote.supports && expectedSupport === 1) || (!vote.supports && expectedSupport === 0))
        assert(vote.stake.eq(expectedStake))
        assert.equal(vote.signature, expectedSignature)
    }
})
