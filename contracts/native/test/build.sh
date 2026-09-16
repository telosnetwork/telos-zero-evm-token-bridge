#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
compiler="${CDT_CPP:-cdt-cpp}"
mkdir -p build
"$compiler" -abigen -contract zero.bridge -I zero.bridge/include -I zero.asset/include -o build/zero.bridge.wasm zero.bridge/src/zero.bridge.cpp
"$compiler" -abigen -contract zero.asset -I zero.asset/include -o build/zero.asset.wasm zero.asset/src/zero.asset.cpp
"$compiler" -abigen -contract mock.evm -o build/mock.evm.wasm test/mock.evm.cpp
