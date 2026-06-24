// SPDX-License-Identifier: MIT
#pragma once

#include <eosio/eosio.hpp>
#include <cstdint>
#include <vector>

namespace zeroevm::rlp {

using bytes = std::vector<uint8_t>;

inline bytes minimal_be(uint64_t value) {
    bytes output;
    if (value == 0) return output;
    bool started = false;
    for (int i = 7; i >= 0; --i) {
        uint8_t byte = static_cast<uint8_t>((value >> (i * 8)) & 0xff);
        if (byte != 0 || started) {
            output.push_back(byte);
            started = true;
        }
    }
    return output;
}

inline bytes minimal_be(eosio::checksum256 value) {
    bytes output;
    auto raw = value.extract_as_byte_array();
    bool started = false;
    for (auto byte : raw) {
        if (byte != 0 || started) {
            output.push_back(byte);
            started = true;
        }
    }
    return output;
}

inline bytes length_prefix(size_t length, uint8_t short_offset, uint8_t long_offset) {
    if (length <= 55) {
        return bytes{static_cast<uint8_t>(short_offset + length)};
    }

    bytes length_bytes = minimal_be(static_cast<uint64_t>(length));
    bytes output{static_cast<uint8_t>(long_offset + length_bytes.size())};
    output.insert(output.end(), length_bytes.begin(), length_bytes.end());
    return output;
}

inline bytes encode_bytes(const bytes& value) {
    if (value.size() == 1 && value[0] < 0x80) {
        return value;
    }

    bytes output = length_prefix(value.size(), 0x80, 0xb7);
    output.insert(output.end(), value.begin(), value.end());
    return output;
}

inline bytes encode_uint64(uint64_t value) {
    return encode_bytes(minimal_be(value));
}

inline bytes encode_uint256(eosio::checksum256 value) {
    return encode_bytes(minimal_be(value));
}

inline bytes encode_list(const std::vector<bytes>& encoded_items) {
    bytes payload;
    for (const auto& item : encoded_items) {
        payload.insert(payload.end(), item.begin(), item.end());
    }

    bytes output = length_prefix(payload.size(), 0xc0, 0xf7);
    output.insert(output.end(), payload.begin(), payload.end());
    return output;
}

inline bytes encode_legacy_tx(
    uint64_t nonce,
    eosio::checksum256 gas_price,
    uint64_t gas_limit,
    const bytes& to,
    const bytes& data,
    uint64_t chain_id
) {
    return encode_list({
        encode_uint64(nonce),
        encode_uint256(gas_price),
        encode_uint64(gas_limit),
        encode_bytes(to),
        encode_uint64(0),
        encode_bytes(data),
        encode_uint64(chain_id),
        encode_uint64(0),
        encode_uint64(0),
    });
}

} // namespace zeroevm::rlp
