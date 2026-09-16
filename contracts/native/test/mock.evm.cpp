// SPDX-License-Identifier: MIT
// Test-only eosio.evm fixture. It models native tables and raw failure semantics,
// not EVM bytecode execution (which is covered independently by Foundry).
#include <eosio/eosio.hpp>
#include <eosio/crypto.hpp>
#include <eosio/singleton.hpp>
#include <eosio/binary_extension.hpp>
#include <optional>
#include <vector>
using namespace eosio;

class [[eosio::contract("mock.evm")]] mockevm : public contract {
public:
    using contract::contract;
    struct [[eosio::table]] account {
        uint64_t index;
        checksum160 address;
        name account_name;
        uint64_t nonce = 1;
        std::vector<uint8_t> code;
        checksum256 balance;
        uint64_t primary_key() const { return index; }
        uint64_t byaccount() const { return account_name.value; }
        checksum256 byaddress() const {
            auto a = address.extract_as_byte_array(); std::array<uint8_t,32> b{};
            std::copy(a.begin(), a.end(), b.begin()+12); return checksum256(b);
        }
    };
    using accounts = multi_index<"account"_n, account,
        indexed_by<"byaddress"_n,const_mem_fun<account,checksum256,&account::byaddress>>,
        indexed_by<"byaccount"_n,const_mem_fun<account,uint64_t,&account::byaccount>>>;
    struct [[eosio::table]] accountstate {
        uint64_t index; checksum256 key; checksum256 value;
        uint64_t primary_key() const { return index; }
        checksum256 bykey() const { return key; }
    };
    using states = multi_index<"accountstate"_n,accountstate,
        indexed_by<"bykey"_n,const_mem_fun<accountstate,checksum256,&accountstate::bykey>>>;
    struct [[eosio::table("config")]] config {
        uint32_t trx_index=0; uint32_t last_block=0;
        checksum256 gas_used_block; checksum256 gas_price;
        binary_extension<uint32_t> revision;
    };
    struct [[eosio::table("result")]] result {
        uint64_t scope; checksum256 key; checksum256 value; bool fail;
    };
    struct [[eosio::table("calls")]] calls {
        uint64_t count = 0; std::vector<uint8_t> tx;
    };
    [[eosio::action]] void seedacct(uint64_t index, checksum160 address, name account_name, std::vector<uint8_t> code) {
        require_auth(get_self()); accounts rows(get_self(),get_self().value);
        rows.emplace(get_self(),[&](auto& r){r.index=index;r.address=address;r.account_name=account_name;r.code=code;});
        singleton<"config"_n,config> conf(get_self(),get_self().value);
        if (!conf.exists()) conf.set(config{},get_self()); // Omit optional revision deliberately.
    }
    [[eosio::action]] void setstorage(uint64_t scope, checksum256 key, checksum256 value) {
        require_auth(get_self()); put(scope,key,value);
    }
    [[eosio::action]] void setresult(uint64_t scope, checksum256 key, checksum256 value, bool fail) {
        require_auth(get_self()); singleton<"result"_n,result> r(get_self(),get_self().value);
        r.set(result{scope,key,value,fail},get_self());
    }
    [[eosio::action]] void raw(name payer, std::vector<uint8_t> tx, bool estimate_gas, std::optional<checksum160> sender) {
        require_auth(payer); check(!estimate_gas && sender.has_value(),"invalid fixture raw call");
        singleton<"calls"_n,calls> c(get_self(),get_self().value);
        auto call=c.get_or_default(); call.count++; call.tx=tx; c.set(call,get_self());
        singleton<"result"_n,result> r(get_self(),get_self().value); auto outcome=r.get();
        // A failed EVM execution can return normally from the native raw action.
        if (!outcome.fail) put(outcome.scope,outcome.key,outcome.value);
    }
private:
    void put(uint64_t scope, checksum256 key, checksum256 value) {
        states rows(get_self(),scope); auto bykey=rows.get_index<"bykey"_n>(); auto it=bykey.find(key);
        if(it==bykey.end()) rows.emplace(get_self(),[&](auto& r){r.index=rows.available_primary_key();r.key=key;r.value=value;});
        else bykey.modify(it,same_payer,[&](auto& r){r.value=value;});
    }
};
