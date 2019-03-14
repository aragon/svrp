module.exports = web3 => {
    function parseArguments(args) {
        const params = Array.prototype.slice.call(args)
        if (params.length === 3) return params
        if (params.length === 1) return [...params, {}, '']
        if (params.length === 2) {
            const lastArg = params[params.length - 1]
            if (typeof(lastArg) === 'string') return [params[0], {}, params[1]]
            if (typeof(lastArg) === 'object' && !Array.isArray(lastArg)) return [...params, '']
            else throw 'Assert revert second argument is not valid, was expecting an object or string'
        }
        else throw 'Assert revert was expecting at least 1 argument: method call'
    }

    function decodeReason(returnValue) {
        if (returnValue.substring(0, 2) === '0x') returnValue = returnValue.slice(2)

        const rawReason = returnValue
            .slice(8)   // remove identifier: bytes4(keccak256('Error(string)'))
            .slice(128) // remove signature

        let decodedReason = ''
        for (let i = 0; i < rawReason.length; i += 2) {
            const code = parseInt(rawReason.substr(i, 2), 16)
            if (code === 0) continue
            decodedReason += String.fromCharCode(code)
        }

        return decodedReason
    }

    async function transactionWillRevert(tx) {
        try {
            await web3.eth.estimateGas(tx)
            return false
        } catch (error) {
            return true
        }
    }

    return async function () {
        const [methodCall, txParams, reason] = parseArguments(arguments)
        if (!txParams.from) txParams.from = (await web3.eth.getAccounts())[0]

        const to = methodCall._parent._address
        const data = methodCall.encodeABI()
        const tx = { to, data, ...txParams }

        assert.isTrue(await transactionWillRevert(tx), 'Transaction should revert')
        if (reason.lentgh === 0) return true
        const response = await web3.eth.call(tx)
        const reasonFound = decodeReason(response)
        assert.equal(reasonFound, reason, `Revert reason '${reason}' not found. Found '${reasonFound}' instead.` )
    }
}
