const timeTravel = require('@aragon/test-helpers/timeTravel')(web3)
const getBlockNumber = require('@aragon/test-helpers/blockNumber')(web3)
const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const { encodeCallScript, EMPTY_SCRIPT } = require('@aragon/test-helpers/evmScript')

const ACL = artifacts.require('@aragon/os/contracts/acl/ACL')
const Kernel = artifacts.require('@aragon/os/contracts/kernel/Kernel')
const DAOFactory = artifacts.require('@aragon/os/contracts/factory/DAOFactory')
const MiniMeToken = artifacts.require('@aragon/apps-shared-minime/contracts/MiniMeToken')
const EVMScriptRegistryFactory = artifacts.require('@aragon/os/contracts/factory/EVMScriptRegistryFactory')

const Voting = artifacts.require('VotingMock')
const ExecutionTarget = artifacts.require('ExecutionTarget')

const pct16 = x => bigExp(x, 16)
const bigExp = (x, y) => new web3.BigNumber(x).times(new web3.BigNumber(10).toPower(y))
const getContract = name => artifacts.require(name)
const createdVoteId = receipt => startVoteEvent(receipt).voteId
const submittedBatchId = receipt => submitBatchEvent(receipt).batchId
const startVoteEvent = receipt => receipt.logs.filter(x => x.event === 'StartVote')[0].args
const submitBatchEvent = receipt => receipt.logs.filter(x => x.event === 'SubmitBatch')[0].args
const acceptChallengeEvent = receipt => receipt.logs.filter(x => x.event === 'AcceptChallenge')[0].args

const NULL_ADDRESS = '0x00'
const ANY_ADDR = '0xffffffffffffffffffffffffffffffffffffffff'

contract('Voting app', ([root, holder1, holder2, holder20, holder29, holder51, nonHolder, relayer]) => {
    const votingTime = 1000
    const challengeWindowSeconds = 7 * 60 * 60 * 24 // 7 days

    let daoFactory, votingBase, voting, voteId, batchId, relayerBalance, script, token, collateralToken, executionTarget
    let APP_MANAGER_ROLE, CREATE_VOTES_ROLE, SUBMIT_BATCH_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE

    before('setup kernel', async function () {
        const kernelBase = await getContract('Kernel').new(true) // petrify immediately
        const aclBase = await getContract('ACL').new()
        const regFact = await EVMScriptRegistryFactory.new()
        daoFactory = await DAOFactory.new(kernelBase.address, aclBase.address, regFact.address)
        votingBase = await Voting.new()

        // Setup constants
        APP_MANAGER_ROLE = await kernelBase.APP_MANAGER_ROLE()
        CREATE_VOTES_ROLE = await votingBase.CREATE_VOTES_ROLE()
        SUBMIT_BATCH_ROLE = await votingBase.SUBMIT_BATCH_ROLE()
        MODIFY_SUPPORT_ROLE = await votingBase.MODIFY_SUPPORT_ROLE()
        MODIFY_QUORUM_ROLE = await votingBase.MODIFY_QUORUM_ROLE()
    })

    beforeEach('create permissions', async function () {
        const { logs } = await daoFactory.newDAO(root)
        const dao = Kernel.at(logs.filter(l => l.event === 'DeployDAO')[0].args.dao)
        const acl = ACL.at(await dao.acl())

        await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })

        const { logs: logs2 } = await dao.newAppInstance('0x1234', votingBase.address, '0x', false, { from: root })
        const votingAddress = logs2.filter(l => l.event === 'NewAppProxy')[0].args.proxy;
        voting = Voting.at(votingAddress)

        await acl.createPermission(relayer, votingAddress, SUBMIT_BATCH_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDR, votingAddress, CREATE_VOTES_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDR, votingAddress, MODIFY_QUORUM_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDR, votingAddress, MODIFY_SUPPORT_ROLE, root, { from: root })
    })

    beforeEach('initialize collateral token', async function () {
        const decimals = 18
        relayerBalance = bigExp(2000, decimals)
        collateralToken = await MiniMeToken.new(NULL_ADDRESS, NULL_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime
        await collateralToken.generateTokens(voting.address, relayerBalance)
    })

    describe('isForwarder', function () {
        it('is a forwarder', async function () {
            assert.isTrue(await voting.isForwarder())
        })
    })

    describe('isValuePct', async function () {
        it('tests total = 0', async function () {
            const result1 = await voting.isValuePct(0, 0, pct16(50))
            assert.equal(result1, false, "total 0 should always return false")

            const result2 = await voting.isValuePct(1, 0, pct16(50))
            assert.equal(result2, false, "total 0 should always return false")
        })

        it('tests value = 0', async function () {
            const result1 = await voting.isValuePct(0, 10, pct16(50))
            assert.equal(result1, false, "value 0 should false if pct is non-zero")

            const result2 = await voting.isValuePct(0, 10, 0)
            assert.equal(result2, false, "value 0 should return false if pct is zero")
        })

        it('tests pct ~= 100', async function () {
            const result1 = await voting.isValuePct(10, 10, pct16(100).minus(1))
            assert.equal(result1, true, "value 10 over 10 should pass")
        })

        it('tests strict inequality', async function () {
            const result1 = await voting.isValuePct(10, 20, pct16(50))
            assert.equal(result1, false, "value 10 over 20 should not pass for 50%")

            const result2 = await voting.isValuePct(pct16(50).minus(1), pct16(100), pct16(50))
            assert.equal(result2, false, "off-by-one down should not pass")

            const result3 = await voting.isValuePct(pct16(50).plus(1), pct16(100), pct16(50))
            assert.equal(result3, true, "off-by-one up should pass")
        })
    })

    context('when the voting is not initialized', function () {
        beforeEach('create minime instance', async function () {
            token = await MiniMeToken.new(NULL_ADDRESS, NULL_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime
        })

        context('when using valid percentages', function () {
            const neededSupport = pct16(60)
            const minimumAcceptanceQuorum = pct16(50)

            beforeEach('initialize voting instance', async function () {
                await voting.initialize(token.address, collateralToken.address, neededSupport, minimumAcceptanceQuorum, votingTime)
            })

            it('has a token', async function () {
                assert.equal(await voting.token(), token.address)
            })

            it('has a required support and minimum quorum', async function () {
                assert(neededSupport.eq(await voting.supportRequiredPct()))
                assert(minimumAcceptanceQuorum.eq(await voting.minAcceptQuorumPct()))
            })

            it('has a collateral token and a slashing cost of 1000 tokens', async function () {
                assert.equal(await voting.collateralToken(), collateralToken.address, 'collateral token should match')
                assert((await voting.slashingCost()).eq(new web3.BigNumber('1000e18')), 'slashing cost should be 1000 tokens')
            })

            it('cannot be initialized twice', async function () {
                return assertRevert(async function () {
                    await voting.initialize(token.address, collateralToken.address,neededSupport, minimumAcceptanceQuorum, votingTime)
                })
            })

            it('cannot initialize voting base app', async function () {
                assert.isTrue(await votingBase.isPetrified())

                return assertRevert(async function () {
                    await votingBase.initialize(token.address, collateralToken.address, neededSupport, minimumAcceptanceQuorum, votingTime)
                })
            })
        })

        context('when using invalid percentages', function () {
            it('fails if min acceptance quorum is greater than min support', async function () {
                const neededSupport = pct16(20)
                const minimumAcceptanceQuorum = pct16(50)

                return assertRevert(async function () {
                    await voting.initialize(token.address, collateralToken.address,neededSupport, minimumAcceptanceQuorum, votingTime)
                })
            })

            it('fails if min support is 100% or more', async function () {
                const minimumAcceptanceQuorum = pct16(20)

                await assertRevert(async function () {
                    await voting.initialize(token.address, collateralToken.address,pct16(101), minimumAcceptanceQuorum, votingTime)
                })
                return assertRevert(async function () {
                    await voting.initialize(token.address, collateralToken.address,pct16(100), minimumAcceptanceQuorum, votingTime)
                })
            })
        })
    })

    context('when the voting is initialized', function () {
        const neededSupport = pct16(50)             // yeas must be greater than the 50% of the total votes
        const minimumAcceptanceQuorum = pct16(20)   // yeas must be greater than the 20% of the voting power

        // for (const decimals of [0, 2, 18, 26]) {
        for (const decimals of [18]) {
            context(`with ${decimals} decimals`, () => {
                beforeEach('initialize voting instance', async function () {
                    token = await MiniMeToken.new(NULL_ADDRESS, NULL_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime
                    await voting.initialize(token.address, collateralToken.address,neededSupport, minimumAcceptanceQuorum, votingTime)
                    executionTarget = await ExecutionTarget.new()
                })

                context('with normal total supply', function () {
                    beforeEach('mint minime tokens for holders', async function () {
                        await token.generateTokens(holder20, bigExp(20, decimals))
                        await token.generateTokens(holder29, bigExp(29, decimals))
                        await token.generateTokens(holder51, bigExp(51, decimals))
                    })

                    describe('changeRequiredSupport', function () {
                        it('can change required support', async function () {
                            const receipt = await voting.changeSupportRequiredPct(neededSupport.add(1))
                            const events = receipt.logs.filter(x => x.event === 'ChangeSupportRequired')

                            assert.equal(events.length, 1, 'should have emitted ChangeSupportRequired event')
                            assert.equal((await voting.supportRequiredPct()).toString(), neededSupport.add(1).toString(), 'should have changed required support')
                        })

                        it('fails changing required support lower than minimum acceptance quorum', async function () {
                            return assertRevert(async function () {
                                await voting.changeSupportRequiredPct(minimumAcceptanceQuorum.minus(1))
                            })
                        })

                        it('fails changing required support to 100% or more', async function () {
                            await assertRevert(async () => {
                                await voting.changeSupportRequiredPct(pct16(101))
                            })
                            return assertRevert(async () => {
                                await voting.changeSupportRequiredPct(pct16(100))
                            })
                        })
                    })

                    describe('changeMinimumAcceptanceQuorum', function () {
                        it('can change minimum acceptance quorum', async function () {
                            const receipt = await voting.changeMinAcceptQuorumPct(1)
                            const events = receipt.logs.filter(x => x.event === 'ChangeMinQuorum')

                            assert.equal(events.length, 1, 'should have emitted ChangeMinQuorum event')
                            assert.equal(await voting.minAcceptQuorumPct(), 1, 'should have changed acceptance quorum')
                        })

                        it('fails changing minimum acceptance quorum to greater than min support', async function () {
                            return assertRevert(async () => {
                                await voting.changeMinAcceptQuorumPct(neededSupport.plus(1))
                            })
                        })
                    })

                    context('when there are no votes yet', function () {
                        describe('newVote', function () {
                            const from = holder20

                            context('when the script is not empty', function () {
                                it('creates a vote', async function () {
                                    const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                                    const script = encodeCallScript([action, action])
                                    const receipt = await voting.newVote(script, 'metadata', { from })

                                    const event = startVoteEvent(receipt)
                                    assert.notEqual(event, null)
                                    assert(event.voteId.eq(0))
                                    assert.equal(event.creator, from)
                                    assert.equal(event.metadata, 'metadata')
                                })

                                it('does not execute the script', async function () {
                                    const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                                    const script = encodeCallScript([action])
                                    await voting.newVote(script, '', { from })

                                    assert.equal(await executionTarget.counter(), 0, 'should not have received execution calls')
                                })
                            })

                            context('when the script is empty', function () {
                                const script = EMPTY_SCRIPT

                                it('creates a vote', async function () {
                                    const receipt = await voting.newVote(script, 'metadata', { from })

                                    const event = startVoteEvent(receipt)
                                    assert.notEqual(event, null)
                                    assert(event.voteId.eq(0))
                                    assert.equal(event.creator, from)
                                    assert.equal(event.metadata, 'metadata')
                                })
                            })
                        })

                        describe('forward', function () {
                            it('creates vote', async function () {
                                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                                const script = encodeCallScript([action])
                                const voteId = createdVoteId(await voting.forward(script, { from: holder51 }))

                                assert.equal(voteId, 0, 'voting should have been created')
                            })
                        })
                    })

                    context('when there is an existing vote', function () {
                        beforeEach('create vote', async function () {
                            const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                            script = encodeCallScript([action, action])
                            voteId = createdVoteId(await voting.newVote(script, 'metadata', { from: holder20 }))
                        })

                        describe('getVote', function () {
                            context('when the given ID is valid', async function () {
                                it('fetches the requested vote', async function () {
                                    const [isOpen, isExecuted, _, snapshotBlock, supportRequired, minQuorum, y, n, votingPower, execScript] = await voting.getVote(voteId)

                                    assert.isTrue(isOpen, 'vote should be open')
                                    assert.isFalse(isExecuted, 'vote should not be executed')
                                    assert.equal(snapshotBlock, await getBlockNumber() - 1, 'snapshot block should be correct')
                                    assert.equal(supportRequired.toNumber(), neededSupport.toNumber(), 'required support should be app required support')
                                    assert.equal(minQuorum.toNumber(), minimumAcceptanceQuorum.toNumber(), 'min quorum should be app min quorum')
                                    assert.equal(y, 0, 'initial yea should be 0')
                                    assert.equal(n, 0, 'initial nay should be 0')
                                    assert.equal(votingPower.toString(), bigExp(100, decimals).toString(), 'total voters should be 125')
                                    assert.equal(execScript, script, 'script should be correct')
                                })
                            })

                            context('when the given ID is not valid', async function () {
                                it('reverts', async function () {
                                    return assertRevert(async () => {
                                        await voting.getVote(voteId + 1)
                                    })
                                })
                            })
                        })

                        describe('canSubmit', function () {
                            context('when the given vote exists', function () {
                                context('when the vote is open', function () {
                                    context('when the voting contract has enough balance to pay a challenge', function () {
                                        it('returns true', async function () {
                                            assert(await voting.canSubmit(voteId))
                                        })
                                    })

                                    // FIXME: destroy tokens is failing
                                    xcontext('when the voting contract does not have enough balance to pay a challenge', function () {
                                        beforeEach('destroy tokens', async function () {
                                            await collateralToken.destroyTokens(relayer, relayerBalance)
                                        })

                                        it('returns false', async function () {
                                            assert(!(await voting.canSubmit(voteId)))
                                        })
                                    })
                                })

                                context('when the vote is closed', function () {
                                    beforeEach('close vote', async function () {
                                        await timeTravel(votingTime + 1)
                                    })

                                    it('returns false', async function () {
                                        assert(!(await voting.canSubmit(voteId)))
                                    })
                                })
                            })

                            context('when the given vote does not exist', function () {
                                it('reverts', async function () {
                                    return assertRevert(async () => {
                                        await voting.canSubmit(voteId + 1)
                                    })
                                })
                            })
                        })

                        describe('submitBatch', function () {
                            const size = 3
                            const yeas = bigExp(80, decimals)
                            const nays = bigExp(20, decimals)
                            const proof = "0x"

                            context('when the sender is the relayer', function () {
                                const from = relayer

                                context('when the vote is not executed yet', function () {
                                    context('when the vote is open', function () {
                                        it('adds a new batch to the voting', async function () {
                                            const receipt = await voting.submitBatch(voteId, size, yeas, nays, proof, { from })

                                            const event = submitBatchEvent(receipt)
                                            assert.notEqual(event, null)
                                            assert(event.voteId.eq(voteId))
                                            assert(event.batchId.eq(0))
                                            assert(event.yea.eq(yeas))
                                            assert(event.nay.eq(nays))
                                            assert.equal(event.proof, proof)
                                        })
                                    })

                                    context('when the vote is closed', function () {
                                        beforeEach('close vote', async function () {
                                            await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        })

                                        it('reverts', async function () {
                                            return assertRevert(async () => {
                                                await voting.submitBatch(voteId, size, yeas, nays, proof, { from })
                                            })
                                        })
                                    })
                                })

                                context('when the vote is already executed', function () {
                                    beforeEach('execute vote', async function () {
                                        await voting.submitBatch(voteId, size, yeas, nays, proof, { from })
                                        await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        await voting.executeVote(voteId)
                                    })

                                    it('reverts', async function () {
                                        return assertRevert(async () => {
                                            await voting.submitBatch(voteId, size, yeas, nays, proof, { from })
                                        })
                                    })
                                })
                            })

                            context('when the sender is not the relayer', function () {
                                const from = holder20

                                it('reverts', async function () {
                                    return assertRevert(async () => {
                                        await voting.submitBatch(voteId, size, yeas, nays, proof, { from })
                                    })
                                })
                            })
                        })

                        describe('getBatch', function () {
                            const size = 3
                            const yeas = bigExp(80, decimals)
                            const nays = bigExp(20, decimals)
                            const proof = ''

                            beforeEach('submit batch', async function () {
                                batchId = submittedBatchId(await voting.submitBatch(voteId, size, yeas, nays, proof, { from: relayer }))
                            })

                            context('when the given vote exists', function () {
                                context('when the given batch exists', function () {
                                    it('fetches the requested batch', async function () {
                                        const [valid, yea, nay, length, _, proofHash] = await voting.getBatch(voteId, batchId)

                                        assert(valid, 'batch should be valid by default')
                                        assert(yea.eq(yeas), 'batch yeas should match')
                                        assert(nay.eq(nays), 'batch nays should match')
                                        assert(length.eq(size), 'batch size should match')
                                        assert.equal(proofHash, web3.sha3(proof, { encoding: 'hex' }), 'batch proof should match')
                                    })
                                })

                                context('when the given batch does not exist', function () {
                                    it('reverts', async function () {
                                        return assertRevert(async () => {
                                            await voting.getBatch(voteId, batchId + 1)
                                        })
                                    })
                                })
                            })

                            context('when the given vote does not exist', function () {
                                it('reverts', async function () {
                                    return assertRevert(async () => {
                                        await voting.getBatch(voteId + 1, batchId)
                                    })
                                })
                            })
                        })

                        describe('challenge', function () {
                            const size = 3
                            const yeas = bigExp(80, decimals)
                            const nays = bigExp(20, decimals)
                            const proof = "0x"
                            const challengeProof = "0x"

                            beforeEach('submit batch', async function () {
                                batchId = submittedBatchId(await voting.submitBatch(voteId, size, yeas, nays, proof, { from: relayer }))
                            })

                            context('when the given vote exists', function () {
                                context('when the given batch exists', function () {
                                    context('when the vote is within the challenge period', function () {
                                        context('when the challenge succeeds', function () {
                                            const success = true

                                            it('accepts the challenge', async function () {
                                                const receipt = await voting.challenge(voteId, batchId, challengeProof, success, { from: nonHolder })
                                                const event = acceptChallengeEvent(receipt)

                                                assert.notEqual(event, null, 'event should exist')
                                                assert(event.voteId.eq(voteId), 'vote ID should match')
                                                assert(event.batchId.eq(batchId), 'batch ID should match')
                                                assert.equal(event.sender, nonHolder, 'sender should match')
                                                assert.equal(event.proof, challengeProof, 'sender should match')
                                            })

                                            it('reverts the challenged batch', async  function () {
                                                await voting.challenge(voteId, batchId, challengeProof, success, { from: nonHolder })


                                            })

                                            it('receives the slashing payout', async function () {
                                                const slashingCost = await voting.slashingCost()
                                                const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                await voting.challenge(voteId, batchId, challengeProof, success, { from: nonHolder })

                                                const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                assert(currentBalance.eq(previousBalance.plus(slashingCost)))
                                            })
                                        })

                                        context('when the challenge does not succeed', function () {
                                            const success = false

                                            it('reverts', async  function () {
                                                return assertRevert(async () => {
                                                    await voting.challenge(voteId, batchId, challengeProof, success, { from: nonHolder })
                                                })
                                            })
                                        })
                                    })

                                    context('when the vote is outside the challenge period', function () {
                                        beforeEach('travel outside the challenge period', async function () {
                                            await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        })

                                        context('when the challenge succeeds', function () {
                                            const success = true

                                            it('reverts', async  function () {
                                                return assertRevert(async () => {
                                                    await voting.challenge(voteId, batchId, challengeProof, success, { from: nonHolder })
                                                })
                                            })
                                        })

                                        context('when the challenge does not succeed', function () {
                                            const success = false

                                            it('reverts', async  function () {
                                                return assertRevert(async () => {
                                                    await voting.challenge(voteId, batchId, challengeProof, success, { from: nonHolder })
                                                })
                                            })
                                        })
                                    })
                                })

                                context('when the given batch does not exist', function () {
                                    it('reverts', async function () {
                                        return assertRevert(async () => {
                                            await voting.challenge(voteId, batchId + 1, challengeProof, true, { from: nonHolder })
                                        })
                                    })
                                })
                            })

                            context('when the given vote does not exist', function () {
                                it('reverts', async function () {
                                    return assertRevert(async () => {
                                        await voting.challenge(voteId + 1, batchId, challengeProof, true, { from: nonHolder })
                                    })
                                })
                            })
                        })

                        describe('executeVote', function () {
                            context('when the given vote exists', function () {
                                const size = 2
                                const proof = "0x"

                                context('when there is enough quorum', function () {
                                    const nays = bigExp(20, decimals)

                                    context('when there is enough support', function () {
                                        const yeas = bigExp(29, decimals)

                                        beforeEach('submit batch with enough support', async function () {
                                            await voting.submitBatch(voteId, size, yeas, nays, proof, { from: relayer })
                                            await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        })

                                        it('executes the vote', async function () {
                                            await voting.executeVote(voteId)
                                            assert.equal(await executionTarget.counter(), 2, 'should have executed result')
                                        })

                                        it('cannot re-execute the vote', async function () {
                                            await voting.executeVote(voteId)
                                            return assertRevert(async () => await voting.executeVote(voteId))
                                        })
                                    })

                                    context('when there is not enough support', function () {
                                        const yeas = bigExp(10, decimals)

                                        beforeEach('submit batch without support', async function () {
                                            await voting.submitBatch(voteId, size, yeas, nays, proof, { from: relayer })
                                            await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        })

                                        it('reverts', async function () {
                                            assert(!(await voting.canExecute(voteId)))
                                            await assertRevert(async () => await voting.executeVote(voteId))
                                            assert.equal(await executionTarget.counter(), 0, 'should not have been executed result')
                                        })
                                    })
                                })

                                context('when there is not enough quorum', function () {
                                    const nays = bigExp(0, decimals)

                                    context('when there is enough support', function () {
                                        const yeas = bigExp(19, decimals)

                                        beforeEach('submit batch with enough support', async function () {
                                            await voting.submitBatch(voteId, size, yeas, nays, proof, { from: relayer })
                                            await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        })

                                        it('reverts', async function () {
                                            assert(!(await voting.canExecute(voteId)))
                                            await assertRevert(async () => await voting.executeVote(voteId))
                                            assert.equal(await executionTarget.counter(), 0, 'should not have been executed result')
                                        })
                                    })

                                    context('when there is not enough support', function () {
                                        const yeas = bigExp(9, decimals)

                                        beforeEach('submit batch without support', async function () {
                                            await voting.submitBatch(voteId, size, yeas, nays, proof, { from: relayer })
                                            await timeTravel(votingTime + challengeWindowSeconds + 1)
                                        })

                                        it('reverts', async function () {
                                            assert(!(await voting.canExecute(voteId)))
                                            await assertRevert(async () => await voting.executeVote(voteId))
                                            assert.equal(await executionTarget.counter(), 0, 'should not have been executed result')
                                        })
                                    })
                                })
                            })

                            context('when the given vote does not exist', function () {
                                it('reverts', async function () {
                                    return assertRevert(async () => await voting.executeVote(voteId + 1))
                                })
                            })
                        })

                        describe('changeRequiredSupport', function () {
                            it('does not affect the vote', async function () {
                                await voting.changeSupportRequiredPct(pct16(70))

                                // With previous required support at 50%, vote should be approved
                                // with new quorum at 70% it shouldn't have, but since min quorum is snapshotted
                                // it will succeed

                                const size = 2
                                const yeas = bigExp(69, decimals)
                                const nays = bigExp(10, decimals)
                                await voting.submitBatch(voteId, size, yeas, nays, 'proof', { from: relayer })
                                await timeTravel(votingTime + challengeWindowSeconds + 1)

                                const state = await voting.getVote(voteId)
                                assert(state[4].eq(neededSupport), 'required support in vote should stay equal')

                                // can be executed
                                assert(await voting.canExecute(voteId), 'voting should be allowed to be executed')
                                await voting.executeVote(voteId)
                            })
                        })

                        describe('changeMinimumAcceptanceQuorum', function () {
                            it('doesnt affect the vote', async function () {
                                await voting.changeMinAcceptQuorumPct(pct16(50))

                                // With previous min acceptance quorum at 20%, vote should be approved
                                // with new quorum at 50% it shouldn't have, but since min quorum is snapshotted
                                // it will succeed

                                const size = 2
                                const yeas = bigExp(29, decimals)
                                const nays = bigExp(0, decimals)
                                await voting.submitBatch(voteId, size, yeas, nays, 'proof', { from: relayer })
                                await timeTravel(votingTime + challengeWindowSeconds + 1)

                                const state = await voting.getVote(voteId)
                                assert(state[5].eq(minimumAcceptanceQuorum), 'acceptance quorum in vote should stay equal')

                                // can be executed
                                assert(await voting.canExecute(voteId), 'voting should be allowed to be executed')
                                await voting.executeVote(voteId) // exec doesn't fail
                            })
                        })

                        // TODO: allow holders to vote
                        xdescribe('vote', function () {
                            context('when the sender is a token holder', async function () {
                                context('when the holder did not vote yet', async function () {
                                    context('when automatic execution is allowed', function () {
                                        context('when the vote is not executed yet', function () {
                                            context('when the vote is open', function () {
                                                it('votes', async function () {})

                                                it('executes the vote script', async function () {})

                                                it('token transfers do not affect', async function () {})
                                            })

                                            context('when the vote is closed', function () {
                                                it('reverts', async function () {})
                                            })
                                        })

                                        context('when the vote is already executed yet', function () {
                                            it('reverts', async function () {})
                                        })
                                    })

                                    context('when automatic execution is not allowed', function () {
                                        it('votes', async function () {})

                                        it('does not execute the vote script', async function () {})
                                    })
                                })

                                context('when the holder has already voted', async function () {
                                    context('when automatic execution is allowed', function () {
                                        it('modifies their vote', async function () {})

                                        it('executes the vote script', async function () {})
                                    })

                                    context('when automatic execution is not allowed', function () {
                                        it('modifies their vote', async function () {})

                                        it('does not execute the vote script', async function () {})
                                    })
                                })
                            })

                            context('when the sender is not a token holder', async function () {
                                it('reverts', async function () {})
                            })
                        })
                    })
                })

                // TODO: fix test scenarios once holders are allowed to vote
                xcontext('with edge total supplies', function () {
                    context('no supply', function () {
                        it('fails creating a survey if token has no holder', async function () {
                            return assertRevert(async () => {
                                await voting.newVote(EMPTY_SCRIPT, 'metadata')
                            })
                        })
                    })

                    context('total supply = 1', function () {
                        beforeEach('mint minime tokens', async function () {
                            await token.generateTokens(holder1, 1)
                        })

                        describe('newVote', function () {
                            context('when automatic execution is allowed', function () {
                                it('creates and executes a vote', async function () {
                                    const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, true, { from: holder1 }))
                                    const [isOpen, isExecuted] = await voting.getVote(voteId)

                                    assert.isFalse(isOpen, 'vote should be closed')
                                    assert.isTrue(isExecuted, 'vote should have been executed')
                                })
                            })

                            context('when automatic execution is not allowed', function () {
                                it('creates but does not execute a vote', async function () {
                                    const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, false, { from: holder1 }))
                                    const [isOpen, isExecuted] = await voting.getVote(voteId)

                                    assert.isTrue(isOpen, 'vote should be open')
                                    assert.isFalse(isExecuted, 'vote should not have been executed')
                                })
                            })
                        })

                        describe('canExecute', function () {
                            it('returns false before voting', async function () {
                                // Account creating vote does not have any tokens and therefore doesn't vote
                                const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))
                                assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
                            })
                        })

                        describe('vote', function () {
                            context('when automatic execution is allowed', function () {
                                it('votes and executes', async function () {
                                    const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))
                                    await voting.vote(voteId, true, true, { from: holder1 })

                                    const [isOpen, isExecuted] = await voting.getVote(voteId)
                                    assert.isFalse(isOpen, 'vote should be closed')
                                    assert.isTrue(isExecuted, 'vote should have been executed')
                                })
                            })

                            context('when automatic execution is allowed', function () {
                                it('votes and but does not execute', async function () {
                                    const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))
                                    await voting.vote(voteId, true, false, { from: holder1 })

                                    const [isOpen, isExecuted] = await voting.getVote(voteId)
                                    assert.isFalse(isOpen, 'vote should be closed')
                                    assert.isFalse(isExecuted, 'vote should not have been executed')
                                })
                            })
                        })
                    })

                    context('total supply = 3', () => {
                        // const neededSupport = pct16(34)
                        // const minimumAcceptanceQuorum = pct16(20)

                        beforeEach('mint minime tokens', async function () {
                            await token.generateTokens(holder1, 1)
                            await token.generateTokens(holder2, 2)
                        })

                        it('new vote cannot be executed before holder2 voting', async function () {
                            const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))

                            assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

                            await voting.vote(voteId, true, true, { from: holder1 })
                            await voting.vote(voteId, true, true, { from: holder2 })

                            const [isOpen, isExecuted] = await voting.getVote(voteId)

                            assert.isFalse(isOpen, 'vote should be closed')
                            assert.isTrue(isExecuted, 'vote should have been executed')
                        })

                        it('creating vote as holder2 executes vote', async function () {
                            const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata', { from: holder2 }))
                            const [isOpen, isExecuted] = await voting.getVote(voteId)

                            assert.isFalse(isOpen, 'vote should be closed')
                            assert.isTrue(isExecuted, 'vote should have been executed')
                        })
                    })
                })
            })
        }
    })
})
