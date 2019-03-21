#!/usr/bin/env bash

# Exit script as soon as a command fails.
set -o errexit -o pipefail

# Executes cleanup function at script exit.
#trap cleanup EXIT

cleanup() {
  # Kill the geth instance that we started (if we started one and if it's still running).
  if [ -n "$geth_pid" ] && ps -p $geth_pid > /dev/null; then
    kill -9 $geth_pid
  fi
}

setup() {
  OUTPUT_FILE="nohup.out"

  if [ "$SOLIDITY_COVERAGE" = true ]; then
    PORT="8555"
    WS_PORT="8556"
    NETWORK="coverage"
    GASLIMIT="0xfffffffffff"
  else
    PORT="8545"
    WS_PORT="8546"
    NETWORK="development"
    GASLIMIT="8000000"
  fi
}

start_geth() {
  # Start a geth instance in background
  echo "Starting local dev geth in port $PORT..."

  nohup geth \
    --rpc \
    --rpcport ${PORT} \
    --rpcaddr 'localhost' \
    --rpccorsdomain '*' \
    --rpcapi 'personal,web3,eth,net' \
    --ws \
    --wsport ${WS_PORT} \
    --wsaddr 'localhost' \
    --wsorigins '*' \
    --shh \
    --dev \
    --dev.period 1 \
    --networkid ${PORT} \
    --targetgaslimit ${GASLIMIT} \
    > ${OUTPUT_FILE} &

  geth_pid=$!
  sleep 5
  echo "Running local dev geth with pid ${geth_pid}"
  echo "Creating and funding accounts..."
  geth attach "http://localhost:$PORT" --exec "loadScript('./test/scripts/create-accounts')"
}

run_tests() {
  echo "Running tests..."
  npx truffle test --network ${NETWORK} "$@"
}

measure_coverage() {
  echo "Measuring coverage..."
  npx solidity-coverage "$@"
}

main() {
  setup
  start_geth
#  if [ "$SOLIDITY_COVERAGE" = true ]; then measure_coverage; else run_tests; fi
}

main
