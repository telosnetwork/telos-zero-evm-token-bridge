// SPDX-License-Identifier: MIT
#include "../include/zero.asset.hpp"

namespace zeroevm {

void zeroasset::create(name issuer, asset maximum_supply) {
    require_auth(get_self());

    auto sym = maximum_supply.symbol;
    eosio::check(sym.is_valid(), "invalid symbol name");
    eosio::check(maximum_supply.is_valid(), "invalid supply");
    eosio::check(maximum_supply.amount > 0, "max supply must be positive");

    stats statstable(get_self(), sym.code().raw());
    auto existing = statstable.find(sym.code().raw());
    eosio::check(existing == statstable.end(), "token with symbol already exists");

    statstable.emplace(get_self(), [&](auto& s) {
        s.supply.symbol = maximum_supply.symbol;
        s.max_supply = maximum_supply;
        s.issuer = issuer;
    });
}

void zeroasset::issue(name to, asset quantity, string memo) {
    auto sym = quantity.symbol;
    eosio::check(sym.is_valid(), "invalid symbol name");
    eosio::check(memo.size() <= 256, "memo has more than 256 bytes");

    stats statstable(get_self(), sym.code().raw());
    auto existing = statstable.find(sym.code().raw());
    eosio::check(existing != statstable.end(), "token with symbol does not exist");
    const auto& st = *existing;

    require_auth(st.issuer);
    eosio::check(quantity.is_valid(), "invalid quantity");
    eosio::check(quantity.amount > 0, "must issue positive quantity");
    eosio::check(quantity.symbol == st.supply.symbol, "symbol precision mismatch");
    eosio::check(quantity.amount <= st.max_supply.amount - st.supply.amount, "quantity exceeds available supply");

    statstable.modify(st, same_payer, [&](auto& s) {
        s.supply += quantity;
    });

    add_balance(to, quantity, st.issuer);
}

void zeroasset::burn(name owner, asset quantity, string memo) {
    require_auth(owner);

    auto sym = quantity.symbol;
    eosio::check(sym.is_valid(), "invalid symbol name");
    eosio::check(quantity.is_valid(), "invalid quantity");
    eosio::check(quantity.amount > 0, "must burn positive quantity");
    eosio::check(memo.size() <= 256, "memo has more than 256 bytes");

    stats statstable(get_self(), sym.code().raw());
    auto existing = statstable.find(sym.code().raw());
    eosio::check(existing != statstable.end(), "token with symbol does not exist");
    const auto& st = *existing;
    eosio::check(quantity.symbol == st.supply.symbol, "symbol precision mismatch");

    sub_balance(owner, quantity);
    statstable.modify(st, same_payer, [&](auto& s) {
        s.supply -= quantity;
    });
}

void zeroasset::transfer(name from, name to, asset quantity, string memo) {
    eosio::check(from != to, "cannot transfer to self");
    require_auth(from);
    eosio::check(eosio::is_account(to), "to account does not exist");

    auto sym = quantity.symbol.code();
    stats statstable(get_self(), sym.raw());
    const auto& st = statstable.get(sym.raw(), "token with symbol does not exist");

    require_recipient(from);
    require_recipient(to);

    eosio::check(quantity.is_valid(), "invalid quantity");
    eosio::check(quantity.amount > 0, "must transfer positive quantity");
    eosio::check(quantity.symbol == st.supply.symbol, "symbol precision mismatch");
    eosio::check(memo.size() <= 256, "memo has more than 256 bytes");

    sub_balance(from, quantity);
    add_balance(to, quantity, from);
}

asset zeroasset::get_supply(name token_contract_account, symbol sym) {
    stats statstable(token_contract_account, sym.code().raw());
    const auto& st = statstable.get(sym.code().raw());
    return st.supply;
}

asset zeroasset::get_balance(name token_contract_account, name owner, symbol sym) {
    accounts accountstable(token_contract_account, owner.value);
    const auto& ac = accountstable.get(sym.code().raw());
    return ac.balance;
}

void zeroasset::sub_balance(name owner, asset value) {
    accounts from_acnts(get_self(), owner.value);
    const auto& from = from_acnts.get(value.symbol.code().raw(), "no balance object found");
    eosio::check(from.balance.amount >= value.amount, "overdrawn balance");

    from_acnts.modify(from, owner, [&](auto& a) {
        a.balance -= value;
    });
}

void zeroasset::add_balance(name owner, asset value, name ram_payer) {
    accounts to_acnts(get_self(), owner.value);
    auto to = to_acnts.find(value.symbol.code().raw());
    if (to == to_acnts.end()) {
        to_acnts.emplace(ram_payer, [&](auto& a) {
            a.balance = value;
        });
    } else {
        to_acnts.modify(to, same_payer, [&](auto& a) {
            a.balance += value;
        });
    }
}

} // namespace zeroevm
