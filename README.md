# SVRP <img align="right" src="https://raw.githubusercontent.com/aragon/design/master/readme-logo.png" height="80px" />

⚠️ *This repository contains a work-in-progress implementation of the voting app based on SVRP*

### Voting Relay Protocol (VRP)
VRP is a layer 2 protocol built on Ethereum designed to maximize on-chain voting scalability (by a factor of 2-3 
orders of magnitude compared to naïve voting implementations) by using the [optimist primitive](https://medium.com/@decanus/optimistic-contracts-fb75efa7ca84) 
and vote aggregation by relayers. Thanks to the use of optimistic [EVM Storage Proofs](https://github.com/aragon/evm-storage-proofs) 
almost all ERC20s can be virtually snapshotted and used for voting using VRP.

### Simple Voting Relay Protocol (SVRP)

SVRP is a simpler implementation of VRP that imposes a restriction in the relayer set size, which is limited to 1. 
This relayer can be unilaterally appointed by the organization wishing to use the protocol for elections or it can be 
the entity wishing to be a relayer that has the largest token stake (there may be challenges related to relayer transitions).

Even if the relayer is centrally chosen, it is important that the relayer has a token stake that the stakeholders of the 
organization are comfortable with slashing in case they try to commit fraud.

**You can read specs about how the SVRP in details [here](https://forum.aragon.org/t/simple-voting-relay-protocol-optimistic-vote-tallying/473).**

**You can also keep track of the pending features/improvements we are working on in the [Issues](https://github.com/aragon/svrp/issues) tab of this repo.**
