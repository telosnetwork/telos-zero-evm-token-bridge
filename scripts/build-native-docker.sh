#!/usr/bin/env bash
set -euo pipefail

CDT_VERSION="${CDT_VERSION:-4.1.1}"
CDT_DEB_VERSION="${CDT_DEB_VERSION:-4.1.1-1}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm --platform linux/amd64 \
  -v "${ROOT_DIR}/contracts/native:/work" \
  -w /work \
  "ubuntu:22.04" \
  bash -lc "
    set -euo pipefail
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl cmake make g++ >/dev/null
    curl -L --fail -o /tmp/cdt.deb https://github.com/AntelopeIO/cdt/releases/download/v${CDT_VERSION}/cdt_${CDT_DEB_VERSION}_amd64.deb >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/cdt.deb >/dev/null
    cdt-cpp --version
    rm -rf build
    mkdir build
    cd build
    cmake -DCMAKE_TOOLCHAIN_FILE=/usr/lib/cmake/cdt/CDTWasmToolchain.cmake ..
    make -j\$(nproc)
    ls -lh *.wasm *.abi
  "

if [[ "$(uname -s)" == "Darwin" ]]; then
  chown -R "$(id -u):$(id -g)" "${ROOT_DIR}/contracts/native/build" 2>/dev/null || true
fi
