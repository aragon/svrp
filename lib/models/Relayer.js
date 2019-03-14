const SVRP = require('./SVRP')

const DEFAULT_BATCH_MAX_SIZE = 10
const EMPTY_BATCH = { size: 0, yeas: 0, nays: 0, votes: [], submitted: false }

module.exports = class Relayer {
    constructor(address, votingApp, batchMaxSize = DEFAULT_BATCH_MAX_SIZE) {
        this.batches = [EMPTY_BATCH]
        this.address = address
        this.votingApp = votingApp
        this.batchMaxSize = batchMaxSize
    }

    get currentBatch() {
        return this.batches[this.batches.length - 1];
    }

    async vote(voteData, messageHash) {
        const { votingAddress, sender, stake, signature } = voteData

        this._verifyVotingApp(votingAddress)
        this._verifySignature(sender, messageHash, signature)
        this._verifyBalanceProof(sender, stake)
        this._storeVote(voteData)
        if (this.currentBatch.size === this.batchMaxSize) await this.submitBatch()
    }

    async submitBatch() {
        if (this.currentBatch.size === 0 || this.currentBatch.submitted) return
        const { size, yeas, nays, votes } = this.currentBatch

        const proof = SVRP.encode(votes)
        const voteId = votes[0].voteId // TODO: support multiple votes per batch
        await this.votingApp.submitBatch(voteId, size, yeas, nays, proof, { from: this.address })
        this.currentBatch.submitted = true
        this.batches.push(EMPTY_BATCH)
    }

    _storeVote(voteData) {
        const { supports, stake } = voteData
        this.currentBatch.size++
        this.currentBatch.votes.push(voteData)
        supports ? this.currentBatch.yeas += stake : this.currentBatch.nays += stake
    }

    _verifyBalanceProof(holder, expectedBalance) {
        // TODO: implement off-chain balance proof verification
    }

    _verifySignature(address, hash, signature) {
        // TODO: implement off-chain signature verification, we could use web3 1.x recover
    }

    _verifyVotingApp(votingAddress) {
        if (this.votingApp.address === votingAddress) return
        throw Error(`Relayer for voting app at ${this.votingApp.address} cannot manage votes of another app ${votingAddress}`)
    }
}
