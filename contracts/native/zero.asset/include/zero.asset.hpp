// SPDX-License-Identifier: MIT
#pragma once

#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>
#include <string>

namespace zeroevm {

using eosio::asset;
using eosio::contract;
using eosio::name;
using eosio::same_payer;
using eosio::symbol;
using std::string;

class [[eosio::contract("zero.asset")]] zeroasset : public contract {
public:
    using contract::contract;

    [[eosio::action]] void create(name issuer, asset maximum_supply);
    [[eosio::action]] void issue(name to, asset quantity, string memo);
    [[eosio::action]] void burn(name owner, asset quantity, string memo);
    [[eosio::action]] void transfer(name from, name to, asset quantity, string memo);

    static asset get_supply(name token_contract_account, symbol sym);
    static asset get_balance(name token_contract_account, name owner, symbol sym);

private:
    struct [[eosio::table]] account {
        asset balance;

        uint64_t primary_key() const { return balance.symbol.code().raw(); }
    };

    struct [[eosio::table]] currency_stats {
        asset supply;
        asset max_supply;
        name issuer;

        uint64_t primary_key() const { return supply.symbol.code().raw(); }
    };

    using accounts = eosio::multi_index<"accounts"_n, account>;
    using stats = eosio::multi_index<"stat"_n, currency_stats>;

    void sub_balance(name owner, asset value);
    void add_balance(name owner, asset value, name ram_payer);
};

} // namespace zeroevm
