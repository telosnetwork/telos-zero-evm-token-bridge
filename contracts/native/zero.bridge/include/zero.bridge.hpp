// SPDX-License-Identifier: MIT
#pragma once

#include <eosio/asset.hpp>
#include <eosio/binary_extension.hpp>
#include <eosio/crypto.hpp>
#include <eosio/eosio.hpp>
#include <eosio/singleton.hpp>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

namespace zeroevm {

using eosio::asset;
using eosio::checksum160;
using eosio::checksum256;
using eosio::contract;
using eosio::indexed_by;
using eosio::name;
using eosio::symbol;
using eosio::time_point_sec;
using std::string;

class [[eosio::contract("zero.bridge")]] zerobridge : public contract {
public:
    using contract::contract;

    zerobridge(name receiver, name code, eosio::datastream<const char*> ds);

    [[eosio::action]] void init(name admin, name evm_account, bool dev_mode);
    [[eosio::action]] void setadmin(name admin);
    [[eosio::action]] void setdevmode(bool dev_mode);
    [[eosio::action]] void setevmrelay(name evm_account);
    [[eosio::action]] void setevmconf(checksum160 evm_bridge, uint32_t finality_delay_sec);
    [[eosio::action]] void setevmchain(uint64_t evm_chain_id);
    [[eosio::action]] void pause(bool paused);
    [[eosio::action]] void addpair(
        uint64_t pair_id,
        name token_contract,
        symbol zero_symbol,
        checksum160 evm_token,
        uint8_t evm_decimals,
        asset min_quantity,
        asset max_quantity
    );
    [[eosio::action]] void setpair(uint64_t pair_id, bool active, asset min_quantity, asset max_quantity);
    [[eosio::action]] void processetoz(
        uint64_t pair_id,
        checksum256 evm_request_id,
        name receiver,
        asset quantity,
        checksum160 evm_sender
    );
    [[eosio::action]] void proveetoz(
        uint64_t pair_id,
        checksum256 evm_request_id,
        name receiver,
        asset quantity,
        checksum160 evm_sender
    );
    [[eosio::action]] void refundztoe(uint64_t request_id, string reason);
    [[eosio::action]] void relayztoe(uint64_t request_id);
    [[eosio::action]] void checkrelease(uint64_t request_id);
    [[eosio::action]] void refundetoz(uint64_t evm_request_number, checksum256 evm_request_id);
    [[eosio::action]] void checkrefund(checksum256 evm_request_id);

    [[eosio::on_notify("*::transfer")]] void ontransfer(name from, name to, asset quantity, string memo);

private:
    struct [[eosio::table("config")]] config_row {
        name admin;
        name evm_account;
        bool paused = false;
        bool dev_mode = false;
    };

    struct [[eosio::table("evmconfig")]] evm_config_row {
        checksum160 evm_bridge;
        uint64_t evm_bridge_scope = 0;
        uint32_t finality_delay_sec = 0;
        uint64_t evm_chain_id = 41;
    };

    struct [[eosio::table("pairs")]] pair_row {
        uint64_t pair_id;
        name token_contract;
        symbol zero_symbol;
        checksum160 evm_token;
        uint8_t evm_decimals;
        bool active;
        asset min_quantity;
        asset max_quantity;

        uint64_t primary_key() const { return pair_id; }
        uint128_t by_token_symbol() const {
            return (uint128_t(token_contract.value) << 64) | zero_symbol.raw();
        }
    };

    struct [[eosio::table("etozreqs")]] etoz_request {
        uint64_t request_id;
        checksum256 evm_request_id;
        uint64_t pair_id;
        name receiver;
        asset quantity;
        checksum160 evm_sender;
        time_point_sec processed_at;

        uint64_t primary_key() const { return request_id; }
        checksum256 by_evm_request() const { return evm_request_id; }
    };

    struct [[eosio::table("ztoereqs")]] ztoe_request {
        uint64_t request_id;
        checksum256 burn_id;
        uint64_t pair_id;
        name sender;
        asset quantity;
        string evm_receiver;
        time_point_sec created_at;
        bool refunded = false;

        uint64_t primary_key() const { return request_id; }
        checksum256 by_burn_id() const { return burn_id; }
    };

    // Separate table preserves the serialized layout of existing request rows.
    struct [[eosio::table("ztoestatus")]] ztoe_status {
        uint64_t request_id;
        bool dispatching = false;
        bool completed = false;
        uint64_t primary_key() const { return request_id; }
    };

    struct [[eosio::table, eosio::contract("eosio.evm")]] evm_account {
        uint64_t index;
        checksum160 address;
        name account;
        uint64_t nonce;
        std::vector<uint8_t> code;
        checksum256 balance;

        uint64_t primary_key() const { return index; }
        uint64_t by_account() const { return account.value; }
        checksum256 by_address() const;
    };

    struct [[eosio::table, eosio::contract("eosio.evm")]] evm_account_state {
        uint64_t index;
        checksum256 key;
        checksum256 value;

        uint64_t primary_key() const { return index; }
        checksum256 by_key() const { return key; }
    };

    struct [[eosio::table("config"), eosio::contract("eosio.evm")]] evm_system_config_row {
        uint32_t trx_index;
        uint32_t last_block;
        checksum256 gas_used_block;
        checksum256 gas_price;
        eosio::binary_extension<uint32_t> revision;
    };

    using config_singleton = eosio::singleton<"config"_n, config_row>;
    using evm_config_singleton = eosio::singleton<"evmconfig"_n, evm_config_row>;
    using pairs_table = eosio::multi_index<
        "pairs"_n,
        pair_row,
        indexed_by<"bytokensym"_n, eosio::const_mem_fun<pair_row, uint128_t, &pair_row::by_token_symbol>>
    >;
    using etoz_table = eosio::multi_index<
        "etozreqs"_n,
        etoz_request,
        indexed_by<"byevmreq"_n, eosio::const_mem_fun<etoz_request, checksum256, &etoz_request::by_evm_request>>
    >;
    using ztoe_table = eosio::multi_index<
        "ztoereqs"_n,
        ztoe_request,
        indexed_by<"byburnid"_n, eosio::const_mem_fun<ztoe_request, checksum256, &ztoe_request::by_burn_id>>
    >;
    using evm_account_table = eosio::multi_index<
        "account"_n,
        evm_account,
        indexed_by<"byaddress"_n, eosio::const_mem_fun<evm_account, checksum256, &evm_account::by_address>>,
        indexed_by<"byaccount"_n, eosio::const_mem_fun<evm_account, uint64_t, &evm_account::by_account>>
    >;
    using ztoe_status_table = eosio::multi_index<"ztoestatus"_n, ztoe_status>;
    using evm_account_state_table = eosio::multi_index<
        "accountstate"_n,
        evm_account_state,
        indexed_by<"bykey"_n, eosio::const_mem_fun<evm_account_state, checksum256, &evm_account_state::by_key>>
    >;
    using evm_system_config_singleton = eosio::singleton<"config"_n, evm_system_config_row>;

    config_singleton config;
    evm_config_singleton evmconfig;

    config_row get_config();
    evm_config_row get_evm_config();
    void require_admin();
    evm_account get_linked_bridge_evm_account();
    pair_row get_active_pair(name token_contract, symbol zero_symbol) const;
    pair_row get_active_pair(uint64_t pair_id) const;
    void release_ztoe_request(uint64_t request_id);
    void dispatch_evm(const std::vector<uint8_t>& calldata);
    checksum256 read_evm_storage(uint64_t evm_scope, checksum256 key) const;
    checksum256 read_evm_gas_price() const;
    static void check_evm_address_string(const string& value);
    static checksum160 parse_evm_address_string(const string& value);
    static checksum256 checksum160_to_padded_checksum256(checksum160 value);
    static checksum256 evm_request_proof_base_slot(checksum256 evm_request_id);
    static checksum256 evm_request_proof_slot(checksum256 evm_request_id, uint8_t offset);
    static checksum256 processed_zero_burn_slot(checksum256 burn_id);
    static checksum256 keccak256_bytes(const std::array<uint8_t, 64>& input);
    static checksum256 add_storage_slot_offset(checksum256 slot, uint8_t offset);
    static uint64_t checksum256_to_uint64(checksum256 value, const char* error_message);
    static uint128_t checksum256_to_uint128(checksum256 value, const char* error_message);
    static bool checksum256_is_one(checksum256 value);
    static bool padded_address_equals(checksum256 storage_word, checksum160 address);
    static checksum256 zero_receiver_hash(name receiver);
    static checksum256 make_burn_id(name sender, asset quantity, const string& evm_receiver, uint64_t request_id);
    static uint128_t convert_asset_amount_to_evm(asset quantity, uint8_t evm_decimals);
    static std::vector<uint8_t> build_release_calldata(const ztoe_request& request, const pair_row& pair);
};

} // namespace zeroevm
