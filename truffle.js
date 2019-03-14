module.exports = {
    networks: {
        development: {
            host: 'localhost',
            port: 8545,
            gas: 6.4e6,
            gasPrice: 1e9,
            network_id: '8545'
        },
        coverage: {
            host: 'localhost',
            network_id: '8555',
            port: 8555,
            gas: 0xffffffffff,
            gasPrice: 0x01
        },
    },
    compilers: {
        solc: {
            version: '0.4.24',
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 200
                }
            }
        }
    }
}
