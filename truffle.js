module.exports = {
    networks: {
        development: {
            host: 'localhost',
            network_id: '*',
            port: 8545,
            gas: 6.4e6,
            gasPrice: 1e6
        },
        coverage: {
            host: 'localhost',
            network_id: '*',
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
                    runs: 10000
                }
            }
        }
    }
}
