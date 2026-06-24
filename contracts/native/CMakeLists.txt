cmake_minimum_required(VERSION 3.16)
project(zero_evm_bridge_native)

find_package(cdt)

add_contract(zero.asset zero.asset
    zero.asset/src/zero.asset.cpp
)
target_include_directories(zero.asset PUBLIC zero.asset/include)

add_contract(zero.bridge zero.bridge
    zero.bridge/src/zero.bridge.cpp
)
target_include_directories(zero.bridge PUBLIC zero.bridge/include zero.asset/include)
