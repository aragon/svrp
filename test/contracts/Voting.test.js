const RLP = require('rlp')
const SVRP = require('../../lib/models/SVRP')
const { signVote } = require('../../lib/helpers/sign')(web3)
const { bn, pct, bigExp } = require('../../lib/helpers/numbers')(web3)

const Web3Proofs = require('@aragon/web3-proofs')
const assertRevert = require('../../lib/helpers/assertRevertGeth')(web3)
const getBlockNumber = require('@aragon/test-helpers/blockNumber')(web3)
const getStorage = require('@aragon/evm-storage-proofs/test/helpers/get-storage')(web3)
const { encodeCallScript, EMPTY_SCRIPT } = require('@aragon/test-helpers/evmScript')

const ERC20 = artifacts.require('ERC20Mock')
const Voting = artifacts.require('VotingMock')
const ExecutionTarget = artifacts.require('ExecutionTarget')
const StorageOracle = artifacts.require('@aragon/evm-storage-proofs/contracts/StorageOracle')
const TokenStorageProofs = artifacts.require('@aragon/evm-storage-proofs/contracts/adapters/TokenStorageProofs')
const ACL = artifacts.require('@aragon/os/contracts/acl/ACL')
const Kernel = artifacts.require('@aragon/os/contracts/kernel/Kernel')
const DAOFactory = artifacts.require('@aragon/os/contracts/factory/DAOFactory')
const MiniMeToken = artifacts.require('@aragon/apps-shared-minime/contracts/MiniMeToken')
const EVMScriptRegistryFactory = artifacts.require('@aragon/os/contracts/factory/EVMScriptRegistryFactory')

const hex = x => web3.utils.toHex(x)
const createdVoteId = receipt => startVoteEvent(receipt).voteId
const submittedBatchId = receipt => submitBatchEvent(receipt).batchId
const startVoteEvent = receipt => receipt.logs.filter(x => x.event === 'StartVote')[0].args
const submitBatchEvent = receipt => receipt.logs.filter(x => x.event === 'SubmitBatch')[0].args
const invalidVoteEvent = receipt => receipt.logs.filter(x => x.event === 'InvalidVote')[0].args
const invalidVoteStakeEvent = receipt => receipt.logs.filter(x => x.event === 'InvalidVoteStake')[0].args
const invalidAggregationEvent = receipt => receipt.logs.filter(x => x.event === 'InvalidAggregation')[0].args
const voteDuplicationEvent = (receipt, i = 0) => receipt.logs.filter(x => x.event === 'VoteDuplication')[i].args

const ANY_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('Voting app', accounts => {
    const VOTING_TIME = 1000
    const SLASHING_COST = bigExp(1000, 18)
    const CHALLENGE_WINDOW_IN_SECONDS = 7 * 60 * 60 * 24 // 7 days

    // we sort accounts to make testing easier since relayers must submit batches ordered
    const [root, holder1, holder2, holder20, holder29, holder51, nonHolder, relayer] = accounts.sort()

    let daoFactory, votingBase, voting, votingAddress, voteId, batchId, relayerBalance, script, token, collateralToken, executionTarget
    let tokenStorageProofs, storageOracle, supplyProofBlockNumber, supplyProof, balanceProof
    let APP_MANAGER_ROLE, CREATE_VOTES_ROLE, SUBMIT_BATCH_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE

    const web3Proofs = new Web3Proofs()
    const timeTravel = seconds => voting.increaseTime(seconds)
    const advanceBlocks = numbers => voting.advanceBlocks(numbers)

    before('setup kernel', async function () {
        const kernelBase = await Kernel.new(true) // petrify immediately
        const aclBase = await ACL.new()
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
        const dao = await Kernel.at(logs.filter(l => l.event === 'DeployDAO')[0].args.dao)
        const acl = await ACL.at(await dao.acl())

        await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })

        const { logs: logs2 } = await dao.newAppInstance('0x1234', votingBase.address, '0x', false, { from: root })
        votingAddress = logs2.filter(l => l.event === 'NewAppProxy')[0].args.proxy;
        voting = await Voting.at(votingAddress)

        await acl.createPermission(relayer, votingAddress, SUBMIT_BATCH_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDRESS, votingAddress, CREATE_VOTES_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDRESS, votingAddress, MODIFY_QUORUM_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDRESS, votingAddress, MODIFY_SUPPORT_ROLE, root, { from: root })
    })

    beforeEach('initialize collateral and token storage proofs', async function () {
        const decimals = 18
        relayerBalance = bigExp(2000, decimals)
        collateralToken = await ERC20.new()
        await collateralToken.generateTokens(voting.address, relayerBalance)
        storageOracle = await StorageOracle.new()
        tokenStorageProofs = await TokenStorageProofs.new(storageOracle.address)
    })

    describe('isForwarder', function () {
        it('is a forwarder', async function () {
            assert.isTrue(await voting.isForwarder())
        })
    })

    describe('isValuePct', function () {
        it('tests total = 0', async function () {
            const result1 = await voting.isValuePct(0, 0, pct(50))
            assert.equal(result1, false, "total 0 should always return false")

            const result2 = await voting.isValuePct(1, 0, pct(50))
            assert.equal(result2, false, "total 0 should always return false")
        })

        it('tests value = 0', async function () {
            const result1 = await voting.isValuePct(0, 10, pct(50))
            assert.equal(result1, false, "value 0 should false if pct is non-zero")

            const result2 = await voting.isValuePct(0, 10, 0)
            assert.equal(result2, false, "value 0 should return false if pct is zero")
        })

        it('tests pct ~= 100', async function () {
            const result1 = await voting.isValuePct(10, 10, pct(100).sub(bn(1)))
            assert.equal(result1, true, "value 10 over 10 should pass")
        })

        it('tests strict inequality', async function () {
            const result1 = await voting.isValuePct(10, 20, pct(50))
            assert.equal(result1, false, "value 10 over 20 should not pass for 50%")

            const result2 = await voting.isValuePct(pct(50).sub(bn(1)), pct(100), pct(50))
            assert.equal(result2, false, "off-by-one down should not pass")

            const result3 = await voting.isValuePct(pct(50).add(bn(1)), pct(100), pct(50))
            assert.equal(result3, true, "off-by-one up should pass")
        })
    })

    const itShouldManageVotingProperly = function (tokenType, supplySlot, balancesSlot, createToken, getSupplyProof, getBalanceProof) {
        context('when the voting is not initialized', function () {
            beforeEach('create token instance', async function () {
                token = await createToken(0)
            })

            context('when using valid percentages', function () {
                const neededSupport = pct(60)
                const minimumAcceptanceQuorum = pct(50)

                beforeEach('initialize voting instance', async function () {
                    await voting.initialize(token.address, collateralToken.address, tokenStorageProofs.address, tokenType, supplySlot, balancesSlot, neededSupport, minimumAcceptanceQuorum, VOTING_TIME, SLASHING_COST)
                })

                it('has a token', async function () {
                    assert.equal(await voting.token(), token.address)
                })

                it('has a token type, supply slot and balance slot', async function () {
                    assert.equal(await voting.tokenType(), tokenType)
                    assert.equal(await voting.tokenSupplySlot(), supplySlot)
                    assert.equal(await voting.tokenBalancesSlot(), balancesSlot)
                })

                it('has a required support and minimum quorum', async function () {
                    assert(neededSupport.eq(await voting.supportRequiredPct()))
                    assert(minimumAcceptanceQuorum.eq(await voting.minAcceptQuorumPct()))
                })

                it('has a collateral token and a slashing cost of 1000 tokens', async function () {
                    assert.equal(await voting.collateralToken(), collateralToken.address, 'collateral token should match')
                    assert((await voting.slashingCost()).eq(bigExp(1000, 18)), 'slashing cost should be 1000 tokens')
                })

                it('cannot be initialized twice', async function () {
                    await assertRevert(
                        voting.contract.methods.initialize(token.address, collateralToken.address, tokenStorageProofs.address, hex(tokenType), hex(balancesSlot), hex(supplySlot), hex(neededSupport), hex(minimumAcceptanceQuorum), hex(VOTING_TIME), hex(SLASHING_COST)),
                        'INIT_ALREADY_INITIALIZED'
                    )
                })

                it('cannot initialize voting base app', async function () {
                    assert.isTrue(await votingBase.isPetrified())

                    await assertRevert(
                        votingBase.contract.methods.initialize(token.address, collateralToken.address, tokenStorageProofs.address, hex(tokenType), hex(balancesSlot), hex(supplySlot), hex(neededSupport), hex(minimumAcceptanceQuorum), hex(VOTING_TIME), hex(SLASHING_COST)),
                        'INIT_ALREADY_INITIALIZED'
                    )
                })
            })

            context('when using invalid percentages', function () {
                it('fails if min acceptance quorum is greater than min support', async function () {
                    const neededSupport = pct(20)
                    const minimumAcceptanceQuorum = pct(50)

                    await assertRevert(
                        voting.contract.methods.initialize(token.address, collateralToken.address, tokenStorageProofs.address, hex(tokenType), hex(balancesSlot), hex(supplySlot), hex(neededSupport), hex(minimumAcceptanceQuorum), hex(VOTING_TIME), hex(SLASHING_COST)),
                        'VOTING_INIT_PCTS'
                    )
                })

                it('fails if min support is 100% or more', async function () {
                    const minimumAcceptanceQuorum = pct(20)

                    await assertRevert(
                        voting.contract.methods.initialize(token.address, collateralToken.address, tokenStorageProofs.address, hex(tokenType), hex(balancesSlot), hex(supplySlot), hex(pct(101)), hex(minimumAcceptanceQuorum), hex(VOTING_TIME), hex(SLASHING_COST)),
                        'VOTING_INIT_SUPPORT_TOO_BIG'
                    )
                    await assertRevert(
                        voting.contract.methods.initialize(token.address, collateralToken.address, tokenStorageProofs.address, hex(tokenType), hex(balancesSlot), hex(supplySlot), hex(pct(100)), hex(minimumAcceptanceQuorum), hex(VOTING_TIME), hex(SLASHING_COST)),
                        'VOTING_INIT_SUPPORT_TOO_BIG'
                    )
                })
            })
        })

        context('when the voting is initialized', function () {
            const neededSupport = pct(50)             // yeas must be greater than the 50% of the total votes
            const minimumAcceptanceQuorum = pct(20)   // yeas must be greater than the 20% of the voting power

            // for (const decimals of [0, 2, 18, 26]) {
            for (const decimals of [0]) {
                context(`with ${decimals} decimals`, () => {
                    beforeEach('initialize voting instance', async function () {
                        token = await createToken(decimals)
                        await voting.initialize(token.address, collateralToken.address, tokenStorageProofs.address, tokenType, supplySlot, balancesSlot, neededSupport, minimumAcceptanceQuorum, VOTING_TIME, SLASHING_COST)
                        executionTarget = await ExecutionTarget.new()
                    })

                    context('with normal total supply', function () {
                        const holder20Balance = bigExp(20, decimals)
                        const holder29Balance = bigExp(29, decimals)
                        const holder51Balance = bigExp(51, decimals)

                        beforeEach('mint tokens for holders', async function () {
                            await token.generateTokens(holder20, holder20Balance)
                            await token.generateTokens(holder29, holder29Balance)
                            await token.generateTokens(holder51, holder51Balance)
                        })

                        describe('changeRequiredSupport', function () {
                            it('can change required support', async function () {
                                const receipt = await voting.changeSupportRequiredPct(neededSupport.add(bn(1)))
                                const events = receipt.logs.filter(x => x.event === 'ChangeSupportRequired')

                                assert.equal(events.length, 1, 'should have emitted ChangeSupportRequired event')
                                assert.equal((await voting.supportRequiredPct()).toString(), neededSupport.add(bn(1)).toString(), 'should have changed required support')
                            })

                            it('fails changing required support lower than minimum acceptance quorum', async function () {
                                await assertRevert(voting.contract.methods.changeSupportRequiredPct(hex(0)), 'VOTING_CHANGE_SUPPORT_PCTS')
                            })

                            it('fails changing required support to 100% or more', async function () {
                                await assertRevert(voting.contract.methods.changeSupportRequiredPct(hex(pct(101))), 'VOTING_CHANGE_SUPP_TOO_BIG')
                                await assertRevert(voting.contract.methods.changeSupportRequiredPct(hex(pct(100))), 'VOTING_CHANGE_SUPP_TOO_BIG')
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
                                await assertRevert(voting.contract.methods.changeMinAcceptQuorumPct(hex(neededSupport.add(bn(1)))), 'VOTING_CHANGE_QUORUM_PCTS')
                            })
                        })

                        context('when there are no votes yet', function () {
                            beforeEach('build script', async function () {
                                const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
                                script = encodeCallScript([action, action])
                            })

                            describe('newVote', function () {
                                const from = holder20

                                context('when the given storage proof is not valid', function () {
                                    const invalidSupplyProof = '0x0'

                                    // FIXME: getting empty reason for MiniMe
                                    it('reverts', async function () {
                                        const blockNumber = (await getBlockNumber()) - 2
                                        await assertRevert(voting.contract.methods.newVote('metadata', blockNumber, invalidSupplyProof, script), { from: holder20 }, 'UNPROCESSED_STORAGE_ROOT')
                                    })
                                })

                                context('when the given storage proof is valid', function () {
                                    beforeEach('build supply storage proof', async function () {
                                        supplyProof = await getSupplyProof()
                                    })

                                    context('when the current block is not more than 256 blocks away from the proof', function () {

                                        context('when the given block number does not match the one proved', function () {
                                            it('reverts', async function () {
                                                const anotherBlockNumber = supplyProofBlockNumber - 100

                                                await assertRevert(voting.contract.methods.newVote('metadata', anotherBlockNumber, supplyProof, script), { from: holder20 }, 'UNPROCESSED_STORAGE_ROOT')
                                            })
                                        })

                                        context('when the given block number matches the one proved', function () {
                                            context('when the script is not empty', function () {
                                                it('creates a vote', async function () {
                                                    const receipt = await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, script, { from })

                                                    const event = startVoteEvent(receipt)
                                                    assert.notEqual(event, null)
                                                    assert(event.voteId.eq(bn(0)))
                                                    assert.equal(event.creator, from)
                                                    assert.equal(event.metadata, 'metadata')
                                                })

                                                it('does not execute the script', async function () {
                                                    await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, script, { from })

                                                    assert.equal(await executionTarget.counter(), 0, 'should not have received execution calls')
                                                })
                                            })

                                            context('when the script is empty', function () {
                                                it('creates a vote', async function () {
                                                    const receipt = await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT, { from })

                                                    const event = startVoteEvent(receipt)
                                                    assert.notEqual(event, null)
                                                    assert(event.voteId.eq(bn(0)))
                                                    assert.equal(event.creator, from)
                                                    assert.equal(event.metadata, 'metadata')
                                                })
                                            })
                                        })
                                    })

                                    context('when the current block is more than 256 blocks away from the proof', function () {
                                        beforeEach('advance 256 blocks', async function () {
                                            await advanceBlocks(256)
                                        })

                                        context('when the given block number does not match the one proved', function () {
                                            it('reverts', async function () {
                                                const anotherBlockNumber = supplyProofBlockNumber - 200

                                                await assertRevert(voting.contract.methods.newVote('metadata', anotherBlockNumber, supplyProof, script), { from: holder20 }, 'VOTING_BLOCKNUMBER_NOT_ALLOWED')
                                            })
                                        })

                                        context('when the given block number matches the one proved', function () {
                                            it('reverts', async function () {
                                                await assertRevert(voting.contract.methods.newVote('metadata', supplyProofBlockNumber, supplyProof, script), { from: holder20 }, 'VOTING_BLOCKNUMBER_NOT_ALLOWED')
                                            })
                                        })
                                    })
                                })
                            })

                            // TODO: Fix forwards method in the contract to allow receiving a storage proof param
                            xdescribe('forward', function () {
                                it('creates vote', async function () {
                                    const voteId = createdVoteId(await voting.forward(script, { from: holder51 }))

                                    assert.equal(voteId, 0, 'voting should have been created')
                                })
                            })
                        })

                        context('when there is an existing vote', function () {
                            beforeEach('create vote', async function () {
                                supplyProof = await getSupplyProof()
                                const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
                                script = encodeCallScript([action, action])
                                voteId = createdVoteId(await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, script, { from: holder20 }))
                            })

                            describe('getVote', function () {
                                context('when the given ID is valid', async function () {
                                    it('fetches the requested vote', async function () {
                                        const { open, executed, snapshotBlock, supportRequired, minAcceptQuorum, yea, nay, votingPower, script: execScript } = await voting.getVote(voteId)

                                        assert.isTrue(open, 'vote should be open')
                                        assert.isFalse(executed, 'vote should not be executed')
                                        assert.equal(snapshotBlock, supplyProofBlockNumber, 'snapshot block should be correct')
                                        assert(supportRequired.eq(neededSupport), 'required support should be app required support')
                                        assert(minAcceptQuorum.eq(minimumAcceptanceQuorum), 'min quorum should be app min quorum')
                                        assert.equal(yea, 0, 'initial yea should be 0')
                                        assert.equal(nay, 0, 'initial nay should be 0')
                                        assert(votingPower.eq(bigExp(100, decimals)), 'total voters should be 100')
                                        assert.equal(execScript, script, 'script should be correct')
                                    })
                                })

                                context('when the given ID is not valid', async function () {
                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.getVote(hex(voteId + 1)), 'VOTING_NO_VOTE')
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

                                        context('when the voting contract does not have enough balance to pay a challenge', function () {
                                            beforeEach('transfer relayer collateral balance somewhere else', async function () {
                                                const votingBalance = await collateralToken.balanceOf(voting.address)
                                                await collateralToken.burnTokens(voting.address, votingBalance)
                                            })

                                            it('returns false', async function () {
                                                assert(!(await voting.canSubmit(voteId)))
                                            })
                                        })
                                    })

                                    context('when the vote is closed', function () {
                                        beforeEach('close vote', async function () {
                                            await timeTravel(VOTING_TIME + 1)
                                        })

                                        it('returns false', async function () {
                                            assert(!(await voting.canSubmit(voteId)))
                                        })
                                    })
                                })

                                context('when the given vote does not exist', function () {
                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.canSubmit(hex(voteId + 1)), 'VOTING_NO_VOTE')
                                    })
                                })
                            })

                            describe('submitBatch', function () {
                                const yeas = bigExp(80, decimals)
                                const nays = bigExp(20, decimals)
                                const proof = '0x00'

                                context('when the sender is the relayer', function () {
                                    const from = relayer

                                    context('when the vote is not executed yet', function () {
                                        context('when the vote is open', function () {
                                            it('adds a new batch to the voting', async function () {
                                                const receipt = await voting.submitBatch(voteId, yeas, nays, proof, { from })

                                                const event = submitBatchEvent(receipt)
                                                assert.notEqual(event, null)
                                                assert(event.voteId.eq(voteId))
                                                assert(event.batchId.eq(bn(0)))
                                                assert(event.yea.eq(yeas))
                                                assert(event.nay.eq(nays))
                                                assert.equal(event.proof, proof)
                                            })
                                        })

                                        context('when the vote is closed', function () {
                                            beforeEach('close vote', async function () {
                                                await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                            })

                                            it('reverts', async function () {
                                                await assertRevert(voting.contract.methods.submitBatch(hex(voteId), hex(yeas), hex(nays), proof), { from }, 'VOTING_CAN_NOT_SUBMIT_BATCH')
                                            })
                                        })
                                    })

                                    context('when the vote is already executed', function () {
                                        beforeEach('execute vote', async function () {
                                            await voting.submitBatch(voteId, yeas, nays, proof, { from })
                                            await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                            await voting.executeVote(voteId)
                                        })

                                        it('reverts', async function () {
                                            await assertRevert(voting.contract.methods.submitBatch(hex(voteId), hex(yeas), hex(nays), proof), { from }, 'VOTING_CAN_NOT_SUBMIT_BATCH')
                                        })
                                    })
                                })

                                context('when the sender is not the relayer', function () {
                                    const from = holder20

                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.submitBatch(hex(voteId), hex(yeas), hex(nays), proof), { from }, 'APP_AUTH_FAILED')
                                    })
                                })
                            })

                            describe('getBatch', function () {
                                const yeas = bigExp(80, decimals)
                                const nays = bigExp(20, decimals)
                                const proof = '0x0'

                                beforeEach('submit batch', async function () {
                                    batchId = submittedBatchId(await voting.submitBatch(voteId, yeas, nays, proof, { from: relayer }))
                                })

                                context('when the given vote exists', function () {
                                    context('when the given batch exists', function () {
                                        it('fetches the requested batch', async function () {
                                            const { valid, yea, nay, proofHash } = await voting.getBatch(voteId, batchId)

                                            assert(valid, 'batch should be valid by default')
                                            assert(yea.eq(yeas), 'batch yeas should match')
                                            assert(nay.eq(nays), 'batch nays should match')
                                            assert.equal(proofHash, web3.utils.sha3(proof, { encoding: 'hex' }), 'batch proof should match')
                                        })
                                    })

                                    context('when the given batch does not exist', function () {
                                        it('reverts', async function () {
                                            await assertRevert(voting.contract.methods.getBatch(hex(voteId), hex(batchId + 1)), 'VOTING_NO_BATCH')
                                        })
                                    })
                                })

                                context('when the given vote does not exist', function () {
                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.getBatch(hex(voteId + 1), hex(batchId)), 'VOTING_NO_BATCH')
                                    })
                                })
                            })

                            describe('challengeAggregation', function () {
                                let holder20Vote, holder29Vote, holder20Vote2, holder20ForeignVote, submittedYeas, submittedNays
                                let correctProof, proofWithDuplicatedVote, invalidProof, proofWithForeignVotes, proofWithDifferentVotes

                                beforeEach('build vote messages', async function () {
                                    holder20Vote = await signVote(holder20, { votingAddress, voteId, stake: holder20Balance, supports: true })
                                    holder29Vote = await signVote(holder29, { votingAddress, voteId, stake: holder29Balance, supports: true })
                                    holder20Vote2 = await signVote(holder20, { votingAddress, voteId: voteId + 1, stake: holder20Balance, supports: true })
                                    holder20ForeignVote = await signVote(holder20, { votingAddress: ZERO_ADDRESS, voteId, stake: holder20Balance, supports: true })

                                    invalidProof = '0xdead'
                                    correctProof = SVRP.encodeHex([holder20Vote, holder29Vote])
                                    proofWithForeignVotes = SVRP.encodeHex([holder20Vote, holder20ForeignVote])
                                    proofWithDuplicatedVote = SVRP.encodeHex([holder20Vote, holder20Vote])
                                    proofWithDifferentVotes = SVRP.encodeHex([holder20Vote, holder20Vote2])
                                })

                                context('when the given vote exists', function () {
                                    context('when the given batch exists', function () {
                                        context('when the batch is within the challenge period', function () {
                                            context('when the challenge succeeds', function () {
                                                context('when the aggregation was wrong', function () {
                                                    beforeEach('submit batch with wrong totals', async function () {
                                                        submittedYeas = bigExp(20, decimals)
                                                        submittedNays = bigExp(29, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeAggregation(voteId, batchId, correctProof, { from: nonHolder })
                                                        const event = invalidAggregationEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, correctProof, 'proof should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeAggregation(voteId, batchId, correctProof, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeAggregation(voteId, batchId, correctProof, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })

                                                context('when there was a duplicated vote', function () {
                                                    beforeEach('submit batch with duplicated vote', async function () {
                                                        submittedYeas = bigExp(58, decimals)
                                                        submittedNays = bigExp(0, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithDuplicatedVote, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeAggregation(voteId, batchId, proofWithDuplicatedVote, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                        assert.equal(event.proof, proofWithDuplicatedVote, 'proof should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeAggregation(voteId, batchId, proofWithDuplicatedVote, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeAggregation(voteId, batchId, proofWithDuplicatedVote, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })

                                                context('when the proof was invalid', function () {
                                                    beforeEach('submit batch with invalid proof', async function () {
                                                        submittedYeas = bigExp(49, decimals)
                                                        submittedNays = bigExp(20, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, invalidProof, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeAggregation(voteId, batchId, invalidProof, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, invalidProof, 'proof should match')
                                                        assert(event.voteIndex.eq(bn(0)), 'vote index should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeAggregation(voteId, batchId, invalidProof, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeAggregation(voteId, batchId, invalidProof, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })

                                                context('when the proof included a vote from another voting app', function () {
                                                    beforeEach('submit batch with invalid proof', async function () {
                                                        submittedYeas = bigExp(49, decimals)
                                                        submittedNays = bigExp(20, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithForeignVotes, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeAggregation(voteId, batchId, proofWithForeignVotes, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, proofWithForeignVotes, 'proof should match')
                                                        assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeAggregation(voteId, batchId, proofWithForeignVotes, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeAggregation(voteId, batchId, proofWithForeignVotes, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })

                                                context('when the proof included casted votes from different votes', function () {
                                                    beforeEach('submit batch with invalid proof', async function () {
                                                        submittedYeas = bigExp(49, decimals)
                                                        submittedNays = bigExp(20, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithDifferentVotes, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeAggregation(voteId, batchId, proofWithDifferentVotes, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, proofWithDifferentVotes, 'proof should match')
                                                        assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeAggregation(voteId, batchId, proofWithDifferentVotes, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeAggregation(voteId, batchId, proofWithDifferentVotes, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })
                                            })

                                            context('when the challenge does not succeed', function () {
                                                beforeEach('submit valid batch', async function () {
                                                    submittedYeas = bigExp(49, decimals)
                                                    submittedNays = bigExp(0, decimals)
                                                    batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                })

                                                context('when the given proof matches the one submitted by the relayer', function () {
                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeAggregation(hex(voteId), hex(batchId), correctProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                    })
                                                })

                                                context('when the given proof does not match the one submitted by the relayer', function () {
                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeAggregation(hex(voteId), hex(batchId), invalidProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                    })
                                                })
                                            })
                                        })

                                        context('when the batch is out of the challenge period', function () {
                                            context('when the challenge succeeds', function () {
                                                beforeEach('submit batch with wrong totals', async function () {
                                                    submittedYeas = bigExp(20, decimals)
                                                    submittedNays = bigExp(29, decimals)
                                                    batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                    await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                })

                                                it('reverts', async  function () {
                                                    await assertRevert(voting.contract.methods.challengeAggregation(hex(voteId), hex(batchId), correctProof), { from: nonHolder }, 'VOTING_OUT_OF_CHALLENGE_PERIOD')
                                                })
                                            })

                                            context('when the challenge does not succeed', function () {
                                                beforeEach('submit valid batch', async function () {
                                                    submittedYeas = bigExp(49, decimals)
                                                    submittedNays = bigExp(0, decimals)
                                                    batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                    await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                })

                                                it('reverts', async  function () {
                                                    await assertRevert(voting.contract.methods.challengeAggregation(hex(voteId), hex(batchId), correctProof), { from: nonHolder }, 'VOTING_OUT_OF_CHALLENGE_PERIOD')
                                                })
                                            })
                                        })
                                    })

                                    context('when the given batch does not exist', function () {
                                        it('reverts', async function () {
                                            await assertRevert(voting.contract.methods.challengeAggregation(hex(voteId), hex(batchId + 1), correctProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                        })
                                    })
                                })

                                context('when the given vote does not exist', function () {
                                    beforeEach('submit valid batch', async function () {
                                        submittedYeas = bigExp(49, decimals)
                                        submittedNays = bigExp(0, decimals)
                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                    })

                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.challengeAggregation(hex(voteId + 1), hex(batchId), correctProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                    })
                                })
                            })

                            describe('challengeVoteStake', function () {
                                const anyBalanceProof = '0x'
                                let holder20Vote, holder51Vote, holder29Vote, holder20Vote2, holder20ForeignVote, nonHolderVote, submittedYeas, submittedNays, balanceProof
                                let correctProof, proofWithDuplicatedVote, invalidProof, proofWithForeignVotes, proofWithDifferentVotes, proofWithInvalidStakeVotes

                                beforeEach('build vote messages', async function () {
                                    nonHolderVote = await signVote(nonHolder, { votingAddress, voteId, stake: holder29Balance, supports: true })
                                    holder20Vote = await signVote(holder20, { votingAddress, voteId, stake: holder20Balance, supports: true })
                                    holder29Vote = await signVote(holder29, { votingAddress, voteId, stake: holder29Balance, supports: true })
                                    holder20Vote2 = await signVote(holder20, { votingAddress, voteId: voteId + 1, stake: holder20Balance, supports: true })
                                    holder20ForeignVote = await signVote(holder20, { votingAddress: ZERO_ADDRESS, voteId, stake: holder20Balance, supports: true })

                                    invalidProof = '0xdead'
                                    correctProof = SVRP.encodeHex([holder20Vote, holder29Vote])
                                    proofWithForeignVotes = SVRP.encodeHex([holder20Vote, holder20ForeignVote])
                                    proofWithDuplicatedVote = SVRP.encodeHex([holder20Vote, holder20Vote])
                                    proofWithDifferentVotes = SVRP.encodeHex([holder20Vote, holder20Vote2])
                                    proofWithInvalidStakeVotes = SVRP.encodeHex([holder20Vote, nonHolderVote])
                                })

                                context('when the given vote exists', function () {
                                    context('when the given batch exists', function () {
                                        context('when the batch is within the challenge period', function () {
                                            context('when the challenge succeeds', function () {
                                                context('when the vote stake was wrong', function () {
                                                    context('when the batch includes wrong stake values', function () {
                                                        beforeEach('submit batch with wrong stakes', async function () {
                                                            holder20Vote = await signVote(holder20, { votingAddress, voteId, stake: holder20Balance, supports: true })
                                                            holder51Vote = await signVote(holder51, { votingAddress, voteId, stake: holder51Balance.add(bigExp(10, decimals)), supports: true })
                                                            proofWithInvalidStakeVotes = SVRP.encodeHex([holder20Vote, holder51Vote])

                                                            submittedNays = bn(0)
                                                            submittedYeas = holder20Balance.add(holder51Vote.stake)

                                                            batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithInvalidStakeVotes, { from: relayer }))
                                                            balanceProof = await getBalanceProof(holder51, voteId)
                                                        })

                                                        it('accepts the challenge', async function () {
                                                            const receipt = await voting.challengeVoteStake(voteId, batchId, proofWithInvalidStakeVotes, 1, balanceProof, { from: nonHolder })
                                                            const event = invalidVoteStakeEvent(receipt)

                                                            assert.notEqual(event, null, 'event should exist')
                                                            assert(event.voteId.eq(voteId), 'vote ID should match')
                                                            assert(event.batchId.eq(batchId), 'batch ID should match')
                                                            assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                            assert.equal(event.proof, proofWithInvalidStakeVotes, 'proof should match')
                                                            assert.equal(event.storageProof, balanceProof, 'storage proof should match')
                                                        })

                                                        it('reverts the challenged batch', async  function () {
                                                            const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                            await voting.challengeVoteStake(voteId, batchId, proofWithInvalidStakeVotes, 1, balanceProof, { from: nonHolder })

                                                            const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                            assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                            assert(currentNays.add(submittedNays).eq(previousNays))
                                                            assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                        })

                                                        it('transfers the slashing payout', async function () {
                                                            const slashingCost = await voting.slashingCost()
                                                            const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                            await voting.challengeVoteStake(voteId, batchId, proofWithInvalidStakeVotes, 1, balanceProof, { from: nonHolder })

                                                            const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                            assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                        })
                                                    })

                                                    // FIXME: failing for MiniMe
                                                    context('when the batch includes non holders vote', function () {
                                                        beforeEach('submit batch with wrong stakes', async function () {
                                                            holder20Vote = await signVote(holder20, { votingAddress, voteId, stake: holder20Balance, supports: true })
                                                            nonHolderVote = await signVote(nonHolder, { votingAddress, voteId, stake: bigExp(10, decimals), supports: true })
                                                            proofWithInvalidStakeVotes = SVRP.encodeHex([holder20Vote, nonHolderVote])

                                                            submittedNays = bn(0)
                                                            submittedYeas = holder20Balance.add(nonHolderVote.stake)

                                                            batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithInvalidStakeVotes, { from: relayer }))
                                                            balanceProof = await getBalanceProof(nonHolder, voteId)
                                                        })

                                                        it('accepts the challenge', async function () {
                                                            const receipt = await voting.challengeVoteStake(voteId, batchId, proofWithInvalidStakeVotes, 1, balanceProof, { from: nonHolder })
                                                            const event = invalidVoteStakeEvent(receipt)

                                                            assert.notEqual(event, null, 'event should exist')
                                                            assert(event.voteId.eq(voteId), 'vote ID should match')
                                                            assert(event.batchId.eq(batchId), 'batch ID should match')
                                                            assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                            assert.equal(event.proof, proofWithInvalidStakeVotes, 'proof should match')
                                                            assert.equal(event.storageProof, balanceProof, 'storage proof should match')
                                                        })

                                                        it('reverts the challenged batch', async  function () {
                                                            const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                            await voting.challengeVoteStake(voteId, batchId, proofWithInvalidStakeVotes, 1, balanceProof, { from: nonHolder })

                                                            const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                            assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                            assert(currentNays.add(submittedNays).eq(previousNays))
                                                            assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                        })

                                                        it('transfers the slashing payout', async function () {
                                                            const slashingCost = await voting.slashingCost()
                                                            const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                            await voting.challengeVoteStake(voteId, batchId, proofWithInvalidStakeVotes, 1, balanceProof, { from: nonHolder })

                                                            const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                            assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                        })
                                                    })
                                                })

                                                context('when the proof was invalid', function () {
                                                    beforeEach('submit batch with invalid proof', async function () {
                                                        submittedYeas = bigExp(49, decimals)
                                                        submittedNays = bigExp(20, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, invalidProof, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeVoteStake(voteId, batchId, invalidProof, 0, anyBalanceProof, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, invalidProof, 'proof should match')
                                                        assert(event.voteIndex.eq(bn(0)), 'vote index should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeVoteStake(voteId, batchId, invalidProof, 0, anyBalanceProof, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeVoteStake(voteId, batchId, invalidProof, 0, anyBalanceProof, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })

                                                context('when the proof included a vote from another voting app', function () {
                                                    beforeEach('submit batch with invalid proof', async function () {
                                                        submittedYeas = bigExp(49, decimals)
                                                        submittedNays = bigExp(20, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithForeignVotes, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeVoteStake(voteId, batchId, proofWithForeignVotes, 1, anyBalanceProof, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, proofWithForeignVotes, 'proof should match')
                                                        assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeVoteStake(voteId, batchId, proofWithForeignVotes, 1, anyBalanceProof, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeVoteStake(voteId, batchId, proofWithForeignVotes, 1, anyBalanceProof, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })

                                                context('when the proof included casted votes from different votes', function () {
                                                    beforeEach('submit batch with invalid proof', async function () {
                                                        submittedYeas = bigExp(49, decimals)
                                                        submittedNays = bigExp(20, decimals)
                                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, proofWithDifferentVotes, { from: relayer }))
                                                    })

                                                    it('accepts the challenge', async function () {
                                                        const receipt = await voting.challengeVoteStake(voteId, batchId, proofWithDifferentVotes, 1, anyBalanceProof, { from: nonHolder })
                                                        const event = invalidVoteEvent(receipt)

                                                        assert.notEqual(event, null, 'event should exist')
                                                        assert(event.voteId.eq(voteId), 'vote ID should match')
                                                        assert(event.batchId.eq(batchId), 'batch ID should match')
                                                        assert.equal(event.proof, proofWithDifferentVotes, 'proof should match')
                                                        assert(event.voteIndex.eq(bn(1)), 'vote index should match')
                                                    })

                                                    it('reverts the challenged batch', async  function () {
                                                        const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                        await voting.challengeVoteStake(voteId, batchId, proofWithDifferentVotes, 1, anyBalanceProof, { from: nonHolder })

                                                        const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                        assert(currentYeas.add(submittedYeas).eq(previousYeas))
                                                        assert(currentNays.add(submittedNays).eq(previousNays))
                                                        assert(!(await voting.getBatch(voteId, batchId)).valid, 'submitted batch should not be valid')
                                                    })

                                                    it('transfers the slashing payout', async function () {
                                                        const slashingCost = await voting.slashingCost()
                                                        const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                        await voting.challengeVoteStake(voteId, batchId, proofWithDifferentVotes, 1, anyBalanceProof, { from: nonHolder })

                                                        const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                        assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                    })
                                                })
                                            })

                                            context('when the challenge does not succeed', function () {
                                                beforeEach('submit valid batch', async function () {
                                                    submittedYeas = bigExp(49, decimals)
                                                    submittedNays = bigExp(0, decimals)
                                                    batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                })

                                                context('when the given proof matches the one submitted by the relayer', function () {
                                                    // FIXME: getting empty reason for both ERC20 and MiniMe
                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeVoteStake(hex(voteId), hex(batchId), correctProof, hex(1), anyBalanceProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                    })
                                                })

                                                context('when the given proof does not match the one submitted by the relayer', function () {
                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeVoteStake(hex(voteId), hex(batchId), invalidProof, hex(1), anyBalanceProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                    })
                                                })
                                            })
                                        })

                                        context('when the batch is out of the challenge period', function () {
                                            context('when the challenge succeeds', function () {
                                                beforeEach('submit batch with wrong totals', async function () {
                                                    submittedYeas = bigExp(20, decimals)
                                                    submittedNays = bigExp(29, decimals)
                                                    batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                    await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                })

                                                it('reverts', async  function () {
                                                    await assertRevert(voting.contract.methods.challengeVoteStake(hex(voteId), hex(batchId), correctProof, hex(1), anyBalanceProof), { from: nonHolder }, 'VOTING_OUT_OF_CHALLENGE_PERIOD')
                                                })
                                            })

                                            context('when the challenge does not succeed', function () {
                                                beforeEach('submit valid batch', async function () {
                                                    submittedYeas = bigExp(49, decimals)
                                                    submittedNays = bigExp(0, decimals)
                                                    batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                                    await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                })

                                                it('reverts', async  function () {
                                                    await assertRevert(voting.contract.methods.challengeVoteStake(hex(voteId), hex(batchId), correctProof, hex(1), anyBalanceProof), { from: nonHolder }, 'VOTING_OUT_OF_CHALLENGE_PERIOD')
                                                })
                                            })
                                        })
                                    })

                                    context('when the given batch does not exist', function () {
                                        it('reverts', async function () {
                                            await assertRevert(voting.contract.methods.challengeVoteStake(hex(voteId), hex(batchId + 1), correctProof, hex(1), anyBalanceProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                        })
                                    })
                                })

                                context('when the given vote does not exist', function () {
                                    beforeEach('submit valid batch', async function () {
                                        submittedYeas = bigExp(49, decimals)
                                        submittedNays = bigExp(0, decimals)
                                        batchId = submittedBatchId(await voting.submitBatch(voteId, submittedYeas, submittedNays, correctProof, { from: relayer }))
                                    })

                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.challengeVoteStake(hex(voteId + 1), hex(batchId), correctProof, hex(1), anyBalanceProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                    })
                                })
                            })

                            describe('challengeDuplication', function () {
                                let previousHolder20Vote, currentHolder20Vote, currentHolder20Vote2, foreign20Vote, holder29Vote, holder51Vote, currentSubmittedYeas, currentSubmittedNays
                                let incorrectPreviousProof, correctPreviousProof, incorrectCurrentProof, correctCurrentProof, invalidProof, proofWithForeignVotes, proofWithDifferentVotes, previousSubmittedYeas, previousSubmittedNays, previousBatchId, currentBatchId

                                beforeEach('build vote messages', async function () {
                                    holder29Vote = await signVote(holder29, { votingAddress, voteId, stake: holder29Balance, supports: true })
                                    holder51Vote = await signVote(holder51, { votingAddress, voteId, stake: holder51Balance, supports: true })
                                    foreign20Vote = await signVote(holder51, { votingAddress: ZERO_ADDRESS, voteId, stake: holder51Balance, supports: true })
                                    currentHolder20Vote = await signVote(holder20, { votingAddress, voteId, stake: holder20Balance, supports: true })
                                    currentHolder20Vote2 = await signVote(holder20, { votingAddress, voteId: voteId + 1, stake: holder20Balance, supports: true })
                                    previousHolder20Vote = await signVote(holder20, { votingAddress, voteId, stake: holder20Balance, supports: true })

                                    invalidProof = '0xdead'
                                    correctCurrentProof = SVRP.encodeHex([holder51Vote])
                                    incorrectCurrentProof = SVRP.encodeHex([currentHolder20Vote, holder51Vote])
                                    correctPreviousProof = SVRP.encodeHex([previousHolder20Vote, holder29Vote])
                                    incorrectPreviousProof = SVRP.encodeHex([previousHolder20Vote, holder51Vote])
                                    proofWithForeignVotes = SVRP.encodeHex([foreign20Vote, holder51Vote])
                                    proofWithDifferentVotes = SVRP.encodeHex([currentHolder20Vote2, holder51Vote])
                                })

                                context('when the given vote exists', function () {
                                    context('when the given previous batch exists', function () {
                                        context('when the given current batch exists', function () {
                                            context('when the batches are different', function () {
                                                context('when the previous batch is valid', function () {
                                                    context('when the current batch is within the challenge period', function () {
                                                        context('when the challenge succeeds', function () {
                                                            context('when the batch vote was duplicated', function () {
                                                                beforeEach('submit correct batches with duplicated votes', async function () {
                                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                                    previousSubmittedNays = bigExp(0, decimals)
                                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                    currentSubmittedYeas = bigExp(80, decimals)
                                                                    currentSubmittedNays = bigExp(0, decimals)
                                                                    currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, incorrectCurrentProof, { from: relayer }))
                                                                })

                                                                it('accepts the challenge', async function () {
                                                                    const receipt = await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, incorrectCurrentProof, { from: nonHolder })
                                                                    const firstEvent = voteDuplicationEvent(receipt)
                                                                    const secondEvent = voteDuplicationEvent(receipt, 1)

                                                                    assert.notEqual(firstEvent, null, 'event should exist')
                                                                    assert(firstEvent.voteId.eq(voteId), 'vote ID should match')
                                                                    assert(firstEvent.batchId.eq(previousBatchId), 'batch ID should match')
                                                                    assert(firstEvent.voteIndex.eq(bn(0)), 'vote index should match')
                                                                    assert.equal(firstEvent.proof, correctPreviousProof, 'proof should match')

                                                                    assert.notEqual(secondEvent, null, 'event should exist')
                                                                    assert(secondEvent.voteId.eq(voteId), 'vote ID should match')
                                                                    assert(secondEvent.batchId.eq(currentBatchId), 'batch ID should match')
                                                                    assert(secondEvent.voteIndex.eq(bn(0)), 'vote index should match')
                                                                    assert.equal(secondEvent.proof, incorrectCurrentProof, 'proof should match')
                                                                })

                                                                it('reverts the challenged batch', async  function () {
                                                                    const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, incorrectCurrentProof, { from: nonHolder })

                                                                    const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                                    assert(currentYeas.add(currentSubmittedYeas).eq(previousYeas))
                                                                    assert(currentNays.add(currentSubmittedNays).eq(previousNays))
                                                                    assert(!(await voting.getBatch(voteId, currentBatchId)).valid, 'submitted batch should not be valid')
                                                                })

                                                                it('transfers the slashing payout', async function () {
                                                                    const slashingCost = await voting.slashingCost()
                                                                    const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, incorrectCurrentProof, { from: nonHolder })

                                                                    const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                                    assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                                })
                                                            })

                                                            context('when the current proof was invalid', function () {
                                                                beforeEach('submit batches with invalid proof', async function () {
                                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                                    previousSubmittedNays = bigExp(0, decimals)
                                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                    currentSubmittedYeas = bigExp(80, decimals)
                                                                    currentSubmittedNays = bigExp(0, decimals)
                                                                    currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, invalidProof, { from: relayer }))
                                                                })

                                                                it('accepts the challenge', async function () {
                                                                    const receipt = await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, invalidProof, { from: nonHolder })
                                                                    const event = invalidVoteEvent(receipt)

                                                                    assert.notEqual(event, null, 'event should exist')
                                                                    assert(event.voteId.eq(voteId), 'vote ID should match')
                                                                    assert(event.batchId.eq(currentBatchId), 'batch ID should match')
                                                                    assert(event.voteIndex.eq(bn(0)), 'vote index should match')
                                                                    assert.equal(event.proof, invalidProof, 'proof should match')
                                                                })

                                                                it('reverts the challenged batch', async  function () {
                                                                    const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, invalidProof, { from: nonHolder })

                                                                    const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                                    assert(currentYeas.add(currentSubmittedYeas).eq(previousYeas))
                                                                    assert(currentNays.add(currentSubmittedNays).eq(previousNays))
                                                                    assert(!(await voting.getBatch(voteId, currentBatchId)).valid, 'submitted batch should not be valid')
                                                                })

                                                                it('transfers the slashing payout', async function () {
                                                                    const slashingCost = await voting.slashingCost()
                                                                    const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, invalidProof, { from: nonHolder })

                                                                    const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                                    assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                                })
                                                            })

                                                            context('when the proof included a vote from another voting app', function () {
                                                                beforeEach('submit batches including a vote from another app', async function () {
                                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                                    previousSubmittedNays = bigExp(0, decimals)
                                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                    currentSubmittedYeas = bigExp(80, decimals)
                                                                    currentSubmittedNays = bigExp(0, decimals)
                                                                    currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, proofWithForeignVotes, { from: relayer }))
                                                                })

                                                                it('accepts the challenge', async function () {
                                                                    const receipt = await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, proofWithForeignVotes, { from: nonHolder })
                                                                    const event = invalidVoteEvent(receipt)

                                                                    assert.notEqual(event, null, 'event should exist')
                                                                    assert(event.voteId.eq(voteId), 'vote ID should match')
                                                                    assert(event.batchId.eq(currentBatchId), 'batch ID should match')
                                                                    assert(event.voteIndex.eq(bn(0)), 'vote index should match')
                                                                    assert.equal(event.proof, proofWithForeignVotes, 'proof should match')
                                                                })

                                                                it('reverts the challenged batch', async  function () {
                                                                    const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, proofWithForeignVotes, { from: nonHolder })

                                                                    const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                                    assert(currentYeas.add(currentSubmittedYeas).eq(previousYeas))
                                                                    assert(currentNays.add(currentSubmittedNays).eq(previousNays))
                                                                    assert(!(await voting.getBatch(voteId, currentBatchId)).valid, 'submitted batch should not be valid')
                                                                })

                                                                it('transfers the slashing payout', async function () {
                                                                    const slashingCost = await voting.slashingCost()
                                                                    const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, proofWithForeignVotes, { from: nonHolder })

                                                                    const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                                    assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                                })
                                                            })

                                                            context('when the proof included casted votes from different votes', function () {
                                                                beforeEach('submit batch including a casted vote from another vote', async function () {
                                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                                    previousSubmittedNays = bigExp(0, decimals)
                                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                    currentSubmittedYeas = bigExp(80, decimals)
                                                                    currentSubmittedNays = bigExp(0, decimals)
                                                                    currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, proofWithForeignVotes, { from: relayer }))
                                                                })

                                                                it('accepts the challenge', async function () {
                                                                    const receipt = await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, proofWithForeignVotes, { from: nonHolder })
                                                                    const event = invalidVoteEvent(receipt)

                                                                    assert.notEqual(event, null, 'event should exist')
                                                                    assert(event.voteId.eq(voteId), 'vote ID should match')
                                                                    assert(event.batchId.eq(currentBatchId), 'batch ID should match')
                                                                    assert(event.voteIndex.eq(bn(0)), 'vote index should match')
                                                                    assert.equal(event.proof, proofWithForeignVotes, 'proof should match')
                                                                })

                                                                it('reverts the challenged batch', async  function () {
                                                                    const { yea: previousYeas, nay: previousNays } = await voting.getVote(voteId)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, proofWithForeignVotes, { from: nonHolder })

                                                                    const { yea: currentYeas, nay: currentNays } = await voting.getVote(voteId)

                                                                    assert(currentYeas.add(currentSubmittedYeas).eq(previousYeas))
                                                                    assert(currentNays.add(currentSubmittedNays).eq(previousNays))
                                                                    assert(!(await voting.getBatch(voteId, currentBatchId)).valid, 'submitted batch should not be valid')
                                                                })

                                                                it('transfers the slashing payout', async function () {
                                                                    const slashingCost = await voting.slashingCost()
                                                                    const previousBalance = await collateralToken.balanceOf(nonHolder)

                                                                    await voting.challengeDuplication(voteId, previousBatchId, currentBatchId, 0, 0, correctPreviousProof, proofWithForeignVotes, { from: nonHolder })

                                                                    const currentBalance = await collateralToken.balanceOf(nonHolder)
                                                                    assert(currentBalance.eq(previousBalance.add(slashingCost)))
                                                                })
                                                            })
                                                        })

                                                        context('when the challenge does not succeed', function () {
                                                            beforeEach('submit valid batches', async function () {
                                                                previousSubmittedYeas = bigExp(49, decimals)
                                                                previousSubmittedNays = bigExp(0, decimals)
                                                                previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                currentSubmittedYeas = bigExp(51, decimals)
                                                                currentSubmittedNays = bigExp(0, decimals)
                                                                currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, correctCurrentProof, { from: relayer }))
                                                            })

                                                            context('when the given proof matches the one submitted by the relayer', function () {
                                                                it('reverts', async  function () {
                                                                    await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(currentBatchId), hex(0), hex(0), correctPreviousProof, correctCurrentProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                                })
                                                            })

                                                            context('when the given proof does not match the one submitted by the relayer', function () {
                                                                it('reverts', async  function () {
                                                                    await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(currentBatchId), hex(0), hex(0), correctPreviousProof, invalidProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                                })
                                                            })
                                                        })
                                                    })

                                                    context('when the current batch is out of the challenge period', function () {
                                                        context('when the challenge succeeds', function () {
                                                            beforeEach('submit correct batches with duplicated votes', async function () {
                                                                previousSubmittedYeas = bigExp(49, decimals)
                                                                previousSubmittedNays = bigExp(0, decimals)
                                                                previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                currentSubmittedYeas = bigExp(80, decimals)
                                                                currentSubmittedNays = bigExp(0, decimals)
                                                                currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, incorrectCurrentProof, { from: relayer }))

                                                                await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                            })

                                                            it('reverts', async  function () {
                                                                await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(currentBatchId), hex(0), hex(0), correctPreviousProof, incorrectCurrentProof), { from: nonHolder }, 'VOTING_OUT_OF_CHALLENGE_PERIOD')
                                                            })
                                                        })

                                                        context('when the challenge does not succeed', function () {
                                                            beforeEach('submit valid batches', async function () {
                                                                previousSubmittedYeas = bigExp(49, decimals)
                                                                previousSubmittedNays = bigExp(0, decimals)
                                                                previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                                                currentSubmittedYeas = bigExp(51, decimals)
                                                                currentSubmittedNays = bigExp(0, decimals)
                                                                currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, correctCurrentProof, { from: relayer }))
                                                            })

                                                            it('reverts', async  function () {
                                                                await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(currentBatchId), hex(0), hex(0), correctPreviousProof, correctCurrentProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                            })
                                                        })
                                                    })
                                                })

                                                context('when the previous batch is invalid', function () {
                                                    beforeEach('submit correct batches with duplicated votes', async function () {
                                                        previousSubmittedYeas = bigExp(49, decimals)
                                                        previousSubmittedNays = bigExp(0, decimals)
                                                        previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, invalidProof, { from: relayer }))

                                                        currentSubmittedYeas = bigExp(80, decimals)
                                                        currentSubmittedNays = bigExp(0, decimals)
                                                        currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, incorrectCurrentProof, { from: relayer }))
                                                    })

                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(currentBatchId), hex(0), hex(0), invalidProof, incorrectCurrentProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                    })
                                                })
                                            })

                                            context('when the batches are the same', function () {
                                                beforeEach('submit valid batch', async function () {
                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                    previousSubmittedNays = bigExp(0, decimals)
                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))
                                                })

                                                it('reverts', async function () {
                                                    await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(previousBatchId), hex(0), hex(0), correctPreviousProof, correctPreviousProof), { from: nonHolder }, 'VOTING_CHALLENGE_REJECTED')
                                                })
                                            })
                                        })

                                        context('when the given current batch does not exist', function () {
                                            context('when the previous batch is valid', function () {
                                                beforeEach('submit valid previous batch', async function () {
                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                    previousSubmittedNays = bigExp(0, decimals)
                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))
                                                })

                                                context('when the previous batch is within the challenge period', function () {
                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(previousBatchId + 1), hex(0), hex(0), correctPreviousProof, correctCurrentProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                                    })
                                                })

                                                context('when the previous batch is out of the challenge period', function () {
                                                    beforeEach('travel out of the challenge period', async function () {
                                                        await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                    })

                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(previousBatchId + 1), hex(0), hex(0), correctPreviousProof, correctCurrentProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                                    })
                                                })
                                            })

                                            context('when the previous batch is invalid', function () {
                                                beforeEach('submit invalid previous batch', async function () {
                                                    previousSubmittedYeas = bigExp(49, decimals)
                                                    previousSubmittedNays = bigExp(0, decimals)
                                                    previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, incorrectPreviousProof, { from: relayer }))
                                                })

                                                context('when the previous batch is within the challenge period', function () {
                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(previousBatchId + 1), hex(0), hex(0), correctPreviousProof, correctCurrentProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                                    })
                                                })

                                                context('when the previous batch is out of the challenge period', function () {
                                                    beforeEach('travel out of the challenge period', async function () {
                                                        await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                                    })

                                                    it('reverts', async  function () {
                                                        await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId), hex(previousBatchId + 1), hex(0), hex(0), correctPreviousProof, correctCurrentProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                                    })
                                                })
                                            })
                                        })
                                    })

                                    context('when the given previous batch does not exist', function () {
                                        it('reverts', async function () {
                                            await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId), hex(previousBatchId + 3), hex(currentBatchId), hex(0), hex(0), correctPreviousProof, incorrectCurrentProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                        })
                                    })
                                })

                                context('when the given vote does not exist', function () {
                                    beforeEach('submit batches', async function () {
                                        previousSubmittedYeas = bigExp(49, decimals)
                                        previousSubmittedNays = bigExp(0, decimals)
                                        previousBatchId = submittedBatchId(await voting.submitBatch(voteId, previousSubmittedYeas, previousSubmittedNays, correctPreviousProof, { from: relayer }))

                                        currentSubmittedYeas = bigExp(80, decimals)
                                        currentSubmittedNays = bigExp(0, decimals)
                                        currentBatchId = submittedBatchId(await voting.submitBatch(voteId, currentSubmittedYeas, currentSubmittedNays, incorrectCurrentProof, { from: relayer }))
                                    })

                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.challengeDuplication(hex(voteId + 1), hex(previousBatchId), hex(currentBatchId), hex(0), hex(0), correctPreviousProof, incorrectCurrentProof), { from: nonHolder }, 'VOTING_NO_BATCH')
                                    })
                                })
                            })

                            describe('executeVote', function () {
                                context('when the given vote exists', function () {
                                    const proof = '0x'

                                    context('when there is enough quorum', function () {
                                        const nays = bigExp(20, decimals)

                                        context('when there is enough support', function () {
                                            const yeas = bigExp(29, decimals)

                                            beforeEach('submit batch with enough support', async function () {
                                                await voting.submitBatch(voteId, yeas, nays, proof, { from: relayer })
                                                await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                            })

                                            it('executes the vote', async function () {
                                                await voting.executeVote(voteId)
                                                assert.equal(await executionTarget.counter(), 2, 'should have executed result')
                                            })

                                            it('cannot re-execute the vote', async function () {
                                                await voting.executeVote(voteId)
                                                await assertRevert(voting.contract.methods.executeVote(hex(voteId)), 'VOTING_CAN_NOT_EXECUTE')
                                            })
                                        })

                                        context('when there is not enough support', function () {
                                            const yeas = bigExp(10, decimals)

                                            beforeEach('submit batch without support', async function () {
                                                await voting.submitBatch(voteId, yeas, nays, proof, { from: relayer })
                                                await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                            })

                                            it('reverts', async function () {
                                                assert(!(await voting.canExecute(voteId)))
                                                await assertRevert(voting.contract.methods.executeVote(hex(voteId)), 'VOTING_CAN_NOT_EXECUTE')
                                                assert.equal(await executionTarget.counter(), 0, 'should not have been executed result')
                                            })
                                        })
                                    })

                                    context('when there is not enough quorum', function () {
                                        const nays = bigExp(0, decimals)

                                        context('when there is enough support', function () {
                                            const yeas = bigExp(19, decimals)

                                            beforeEach('submit batch with enough support', async function () {
                                                await voting.submitBatch(voteId, yeas, nays, proof, { from: relayer })
                                                await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                            })

                                            it('reverts', async function () {
                                                assert(!(await voting.canExecute(voteId)))
                                                await assertRevert(voting.contract.methods.executeVote(hex(voteId)), 'VOTING_CAN_NOT_EXECUTE')
                                                assert.equal(await executionTarget.counter(), 0, 'should not have been executed result')
                                            })
                                        })

                                        context('when there is not enough support', function () {
                                            const yeas = bigExp(9, decimals)

                                            beforeEach('submit batch without support', async function () {
                                                await voting.submitBatch(voteId, yeas, nays, proof, { from: relayer })
                                                await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)
                                            })

                                            it('reverts', async function () {
                                                assert(!(await voting.canExecute(voteId)))
                                                await assertRevert(voting.contract.methods.executeVote(hex(voteId)), 'VOTING_CAN_NOT_EXECUTE')
                                                assert.equal(await executionTarget.counter(), 0, 'should not have been executed result')
                                            })
                                        })
                                    })
                                })

                                context('when the given vote does not exist', function () {
                                    it('reverts', async function () {
                                        await assertRevert(voting.contract.methods.executeVote(hex(voteId + 1)), 'VOTING_NO_VOTE')
                                    })
                                })
                            })

                            describe('changeRequiredSupport', function () {
                                it('does not affect the vote', async function () {
                                    await voting.changeSupportRequiredPct(pct(70))

                                    // With previous required support at 50%, vote should be approved
                                    // with new quorum at 70% it shouldn't have, but since min quorum is snapshotted
                                    // it will succeed

                                    const yeas = bigExp(69, decimals)
                                    const nays = bigExp(10, decimals)
                                    await voting.submitBatch(voteId, yeas, nays, '0x0', { from: relayer })
                                    await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)

                                    const state = await voting.getVote(voteId)
                                    assert(state[4].eq(neededSupport), 'required support in vote should stay equal')

                                    // can be executed
                                    assert(await voting.canExecute(voteId), 'voting should be allowed to be executed')
                                    await voting.executeVote(voteId)
                                })
                            })

                            describe('changeMinimumAcceptanceQuorum', function () {
                                it('doesnt affect the vote', async function () {
                                    await voting.changeMinAcceptQuorumPct(pct(50))

                                    // With previous min acceptance quorum at 20%, vote should be approved
                                    // with new quorum at 50% it shouldn't have, but since min quorum is snapshotted
                                    // it will succeed

                                    const yeas = bigExp(29, decimals)
                                    const nays = bigExp(0, decimals)
                                    await voting.submitBatch(voteId, yeas, nays, '0x0', { from: relayer })
                                    await timeTravel(VOTING_TIME + CHALLENGE_WINDOW_IN_SECONDS + 1)

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
                    context('with edge total supplies', function () {
                        beforeEach('build supply proof', async function () {
                            supplyProof = await getSupplyProof()
                        })

                        context('no supply', function () {
                            // FIXME: failing for MiniMe
                            it('fails creating a survey if token has no holder', async function () {
                                await assertRevert(voting.contract.methods.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT), 'VOTING_NO_VOTING_POWER')
                            })
                        })

                        xcontext('total supply = 1', function () {
                            beforeEach('mint minime tokens', async function () {
                                await token.generateTokens(holder1, 1)
                            })

                            describe('newVote', function () {
                                context('when automatic execution is allowed', function () {
                                    it('creates and executes a vote', async function () {
                                        const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, true, { from: holder1 }))
                                        const { open, executed } = await voting.getVote(voteId)

                                        assert.isFalse(open, 'vote should be closed')
                                        assert.isTrue(executed, 'vote should have been executed')
                                    })
                                })

                                context('when automatic execution is not allowed', function () {
                                    it('creates but does not execute a vote', async function () {
                                        const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, false, { from: holder1 }))
                                        const { open, executed } = await voting.getVote(voteId)

                                        assert.isTrue(open, 'vote should be open')
                                        assert.isFalse(executed, 'vote should not have been executed')
                                    })
                                })
                            })

                            describe('canExecute', function () {
                                it('returns false before voting', async function () {
                                    // Account creating vote does not have any tokens and therefore doesn't vote
                                    const voteId = createdVoteId(await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT))
                                    assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
                                })
                            })

                            describe('vote', function () {
                                context('when automatic execution is allowed', function () {
                                    it('votes and executes', async function () {
                                        const voteId = createdVoteId(await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT))
                                        await voting.vote(voteId, true, true, { from: holder1 })

                                        const { open, executed } = await voting.getVote(voteId)
                                        assert.isFalse(open, 'vote should be closed')
                                        assert.isTrue(executed, 'vote should have been executed')
                                    })
                                })

                                context('when automatic execution is allowed', function () {
                                    it('votes and but does not execute', async function () {
                                        const voteId = createdVoteId(await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT))
                                        await voting.vote(voteId, true, false, { from: holder1 })

                                        const { open, executed } = await voting.getVote(voteId)
                                        assert.isFalse(open, 'vote should be closed')
                                        assert.isFalse(executed, 'vote should not have been executed')
                                    })
                                })
                            })
                        })

                        xcontext('total supply = 3', () => {
                            // const neededSupport = pct16(34)
                            // const minimumAcceptanceQuorum = pct16(20)

                            beforeEach('mint minime tokens', async function () {
                                await token.generateTokens(holder1, 1)
                                await token.generateTokens(holder2, 2)
                            })

                            it('new vote cannot be executed before holder2 voting', async function () {
                                const voteId = createdVoteId(await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT))

                                assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

                                await voting.vote(voteId, true, true, { from: holder1 })
                                await voting.vote(voteId, true, true, { from: holder2 })

                                const { open, executed } = await voting.getVote(voteId)

                                assert.isFalse(open, 'vote should be closed')
                                assert.isTrue(executed, 'vote should have been executed')
                            })

                            it('creating vote as holder2 executes vote', async function () {
                                const voteId = createdVoteId(await voting.newVote('metadata', supplyProofBlockNumber, supplyProof, EMPTY_SCRIPT, { from: holder2 }))
                                const { open, executed } = await voting.getVote(voteId)

                                assert.isFalse(open, 'vote should be closed')
                                assert.isTrue(executed, 'vote should have been executed')
                            })
                        })
                    })
                })
            }
        })
    }

    context('with an ERC20 token', function () {
        const tokenType = 0
        const supplySlot = '0'
        const balancesSlot = '1'

        const createToken = async decimals => ERC20.new()

        const getSupplyProof = async () => {
            supplyProofBlockNumber = await getBlockNumber()
            const { blockHeaderRLP, accountProofRLP } = await web3Proofs.getProof(token.address, [], supplyProofBlockNumber, false)
            await storageOracle.processStorageRoot(token.address, supplyProofBlockNumber, blockHeaderRLP, accountProofRLP)
            const { storageProofsRLP } = await web3Proofs.getProof(token.address, [supplySlot], supplyProofBlockNumber, false)
            return storageProofsRLP[0]
        }

        const getBalanceProof = async (holder, voteId) => {
            const blockNumber = (await voting.getVote(voteId)).snapshotBlock
            const balanceSlot = await tokenStorageProofs.getVanillaERC20BalanceSlot(holder, balancesSlot)
            const { storageProofsRLP } = await web3Proofs.getProof(token.address, [balanceSlot], blockNumber, false)
            return storageProofsRLP[0]
        }

        itShouldManageVotingProperly(tokenType, supplySlot, balancesSlot, createToken, getSupplyProof, getBalanceProof)
    })

    context('with a MiniMe token', function () {
        const tokenType = 1
        const supplySlot = '10'
        const balancesSlot = '8'

        const encodeMultiproof = proofs => `0x${RLP.encode(proofs.map(proof => Buffer.from(proof.slice(2), 'hex'))).toString('hex')}`

        const createToken = async decimals => MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true)

        const getSupplyProof = async () => {
            supplyProofBlockNumber = await getBlockNumber()
            const { blockHeaderRLP, accountProofRLP } = await web3Proofs.getProof(token.address, [], supplyProofBlockNumber, false)
            await storageOracle.processStorageRoot(token.address, supplyProofBlockNumber, blockHeaderRLP, accountProofRLP)
            const supplyCheckpointsLength = web3.utils.toBN(await getStorage(token.address, supplySlot))
            const checkpointSlot = await tokenStorageProofs.getMinimeCheckpointSlot(supplyCheckpointsLength, supplySlot)
            const { storageProofsRLP } = await web3Proofs.getProof(token.address, [hex(supplySlot), checkpointSlot], supplyProofBlockNumber, false)
            return encodeMultiproof(storageProofsRLP)
        }

        const getBalanceProof = async (holder, voteId) => {
            const balance = await token.balanceOf(holder)
            const blockNumber = (await voting.getVote(voteId)).snapshotBlock

            if (balance.gt(bn(0))) {
                const checkpointLengthSlot = await tokenStorageProofs.getMinimeCheckpointsLengthSlot(holder, balancesSlot)
                const checkpointsLength = web3.utils.toBN(await getStorage(token.address, checkpointLengthSlot))
                const checkpointSlot = await tokenStorageProofs.getMinimeCheckpointSlot(checkpointsLength, checkpointLengthSlot)
                const { storageProofsRLP } = await web3Proofs.getProof(token.address, [checkpointLengthSlot, checkpointSlot], blockNumber, false)
                return encodeMultiproof(storageProofsRLP)
            } else {
                const zeroLengthSlot = await tokenStorageProofs.getMinimeCheckpointsLengthSlot(holder, balancesSlot)
                const { storageProofsRLP } = await web3Proofs.getProof(token.address, [zeroLengthSlot], blockNumber, false)
                return encodeMultiproof(storageProofsRLP)
            }
        }

        itShouldManageVotingProperly(tokenType, supplySlot, balancesSlot, createToken, getSupplyProof, getBalanceProof)
    })
})
