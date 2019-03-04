#!/usr/bin/env bash

# Exit script as soon as a command fails.
set -o errexit -o pipefail

# Executes cleanup function at script exit.
trap cleanup EXIT

cleanup() {
  # Kill the RPC instance that we started (if we started one and if it's still running).
  if [ -n "$rpc_pid" ] && ps -p $rpc_pid > /dev/null; then
    kill -9 $rpc_pid
  fi
}

start_ganache() {
  echo "Starting ganache-cli..."
  nohup npx ganache-cli -i 15 -l 50000000 -e 100000 -p 8545 > /dev/null &
  rpc_pid=$!
  sleep 3
  echo "Running ganache-cli with pid ${rpc_pid}"
}

start_testrpc() {
  echo "Starting testrpc-sc..."
  nohup npx testrpc-sc -i 16 -l 0xfffffffffff -e 10000 -p 8555 > /dev/null &
  rpc_pid=$!
  sleep 3
  echo "Running testrpc-sc with pid ${rpc_pid}"
}

measure_coverage() {
  echo "Measuring coverage..."
  node_modules/.bin/solidity-coverage "$@"
}

run_tests() {
  echo "Running tests..."
  truffle test --network rpc "$@"
}

if [ "$SOLIDITY_COVERAGE" = true ]; then
  start_testrpc
  measure_coverage
else
  start_ganache
  run_tests
fi
