// SPDX-License-Identifier: MIT
#include "../include/zero.bridge.hpp"
#include <algorithm>
#include <keccak256/k.c>

namespace zeroevm {

static constexpr name EVM_SYSTEM_CONTRACT = "eosio.evm"_n;
static constexpr uint8_t PROOF_PAIR_ID_OFFSET = 0;
static constexpr uint8_t PROOF_AMOUNT_OFFSET = 1;
static constexpr uint8_t PROOF_SENDER_OFFSET = 2;
static constexpr uint8_t PROOF_ZERO_RECEIVER_HASH_OFFSET = 3;
static constexpr uint8_t PROOF_CREATED_AT_OFFSET = 4;
static constexpr uint8_t PROOF_EXISTS_OFFSET = 5;
static constexpr uint32_t MAX_FINALITY_DELAY_SEC = 86400;
static const std::array<uint8_t, 32> REQUEST_PROOF_STORAGE_SLOT_BYTES = {
    0xf9, 0x81, 0x17, 0x9b, 0xb6, 0xca, 0x7b, 0xac,
    0xd9, 0xc0, 0x9f, 0xc7, 0xee, 0x84, 0xe0, 0x6a,
    0xae, 0xa9, 0xdc, 0x6e, 0x23, 0x31, 0x4f, 0xa0,
    0x13, 0x35, 0xb7, 0x62, 0x68, 0x5e, 0x87, 0xc1
};

zerobridge::zerobridge(name receiver, name code, eosio::datastream<const char*> ds)
    : contract(receiver, code, ds), config(receiver, receiver.value), evmconfig(receiver, receiver.value) {}

void zerobridge::init(name admin, name evm_account, bool dev_mode) {
    require_auth(get_self());
    eosio::check(!config.exists(), "bridge already initialized");
    eosio::check(eosio::is_account(admin), "admin account does not exist");
    eosio::check(eosio::is_account(evm_account), "linked EVM native account does not exist");
    config.set(config_row{admin, evm_account, false, dev_mode}, get_self());
}

void zerobridge::setadmin(name admin) {
    require_admin();
    eosio::check(eosio::is_account(admin), "admin account does not exist");
    auto conf = get_config();
    conf.admin = admin;
    config.set(conf, get_self());
}

void zerobridge::setdevmode(bool dev_mode) {
    require_admin();
    auto conf = get_config();
    conf.dev_mode = dev_mode;
    config.set(conf, get_self());
}

void zerobridge::setevmconf(checksum160 evm_bridge, uint32_t finality_delay_sec) {
    require_admin();
    eosio::check(finality_delay_sec <= MAX_FINALITY_DELAY_SEC, "finality delay is too large");

    evm_account_table accounts(EVM_SYSTEM_CONTRACT, EVM_SYSTEM_CONTRACT.value);
    auto by_address = accounts.get_index<"byaddress"_n>();
    auto account = by_address.require_find(
        checksum160_to_padded_checksum256(evm_bridge),
        "EVM bridge contract not found in eosio.evm accounts"
    );

    evmconfig.set(evm_config_row{evm_bridge, account->index, finality_delay_sec}, get_self());
}

void zerobridge::pause(bool paused) {
    require_admin();
    auto conf = get_config();
    conf.paused = paused;
    config.set(conf, get_self());
}

void zerobridge::addpair(
    uint64_t pair_id,
    name token_contract,
    symbol zero_symbol,
    checksum160 evm_token,
    uint8_t evm_decimals,
    asset min_quantity,
    asset max_quantity
) {
    require_admin();
    eosio::check(pair_id > 0, "pair id must be positive");
    eosio::check(eosio::is_account(token_contract), "token contract does not exist");
    eosio::check(zero_symbol.is_valid(), "invalid zero symbol");
    eosio::check(evm_decimals <= 36, "invalid EVM decimals");
    eosio::check(min_quantity.is_valid() && max_quantity.is_valid(), "invalid limits");
    eosio::check(min_quantity.symbol == zero_symbol && max_quantity.symbol == zero_symbol, "limit symbol mismatch");
    eosio::check(min_quantity.amount > 0 && max_quantity.amount >= min_quantity.amount, "invalid limits");

    pairs_table pairs(get_self(), get_self().value);
    eosio::check(pairs.find(pair_id) == pairs.end(), "pair id already exists");

    auto by_token_symbol = pairs.get_index<"bytokensym"_n>();
    uint128_t token_symbol_key = (uint128_t(token_contract.value) << 64) | zero_symbol.raw();
    eosio::check(by_token_symbol.find(token_symbol_key) == by_token_symbol.end(), "token/symbol already paired");

    pairs.emplace(get_self(), [&](auto& row) {
        row.pair_id = pair_id;
        row.token_contract = token_contract;
        row.zero_symbol = zero_symbol;
        row.evm_token = evm_token;
        row.evm_decimals = evm_decimals;
        row.active = true;
        row.min_quantity = min_quantity;
        row.max_quantity = max_quantity;
    });
}

void zerobridge::setpair(uint64_t pair_id, bool active, asset min_quantity, asset max_quantity) {
    require_admin();
    pairs_table pairs(get_self(), get_self().value);
    auto itr = pairs.require_find(pair_id, "pair not found");
    eosio::check(min_quantity.symbol == itr->zero_symbol && max_quantity.symbol == itr->zero_symbol, "limit symbol mismatch");
    eosio::check(min_quantity.amount > 0 && max_quantity.amount >= min_quantity.amount, "invalid limits");
    pairs.modify(itr, eosio::same_payer, [&](auto& row) {
        row.active = active;
        row.min_quantity = min_quantity;
        row.max_quantity = max_quantity;
    });
}

void zerobridge::processetoz(
    uint64_t pair_id,
    checksum256 evm_request_id,
    name receiver,
    asset quantity,
    checksum160 evm_sender
) {
    auto conf = get_config();
    require_auth(conf.admin);
    eosio::check(conf.dev_mode, "dev-mode processor disabled; use proveetoz");
    eosio::check(!conf.paused, "bridge is paused");
    eosio::check(eosio::is_account(receiver), "receiver does not exist");

    auto pair = get_active_pair(pair_id);
    eosio::check(quantity.symbol == pair.zero_symbol, "quantity symbol mismatch");
    eosio::check(quantity.amount >= pair.min_quantity.amount, "quantity below minimum");
    eosio::check(quantity.amount <= pair.max_quantity.amount, "quantity above maximum");

    etoz_table requests(get_self(), get_self().value);
    auto by_evm_request = requests.get_index<"byevmreq"_n>();
    eosio::check(by_evm_request.find(evm_request_id) == by_evm_request.end(), "EVM request already processed");

    requests.emplace(get_self(), [&](auto& row) {
        row.request_id = requests.available_primary_key();
        row.evm_request_id = evm_request_id;
        row.pair_id = pair_id;
        row.receiver = receiver;
        row.quantity = quantity;
        row.evm_sender = evm_sender;
        row.processed_at = time_point_sec(eosio::current_time_point());
    });

    eosio::action(
        eosio::permission_level{get_self(), "active"_n},
        pair.token_contract,
        "issue"_n,
        std::make_tuple(receiver, quantity, string("EVM escrow processed"))
    ).send();
}

void zerobridge::proveetoz(
    uint64_t pair_id,
    checksum256 evm_request_id,
    name receiver,
    asset quantity,
    checksum160 evm_sender
) {
    auto conf = get_config();
    auto evm_conf = get_evm_config();
    eosio::check(!conf.paused, "bridge is paused");
    eosio::check(eosio::is_account(receiver), "receiver does not exist");

    auto pair = get_active_pair(pair_id);
    eosio::check(quantity.is_valid(), "invalid quantity");
    eosio::check(quantity.amount > 0, "quantity must be positive");
    eosio::check(quantity.symbol == pair.zero_symbol, "quantity symbol mismatch");
    eosio::check(quantity.amount >= pair.min_quantity.amount, "quantity below minimum");
    eosio::check(quantity.amount <= pair.max_quantity.amount, "quantity above maximum");

    etoz_table requests(get_self(), get_self().value);
    auto by_evm_request = requests.get_index<"byevmreq"_n>();
    eosio::check(by_evm_request.find(evm_request_id) == by_evm_request.end(), "EVM request already processed");

    auto exists_word = read_evm_storage(evm_conf.evm_bridge_scope, evm_request_proof_slot(evm_request_id, PROOF_EXISTS_OFFSET));
    eosio::check(checksum256_is_one(exists_word), "EVM request proof not found");

    auto stored_pair_id = checksum256_to_uint64(
        read_evm_storage(evm_conf.evm_bridge_scope, evm_request_proof_slot(evm_request_id, PROOF_PAIR_ID_OFFSET)),
        "stored EVM pair id is too large"
    );
    eosio::check(stored_pair_id == pair_id, "EVM pair id mismatch");

    auto stored_amount = checksum256_to_uint64(
        read_evm_storage(evm_conf.evm_bridge_scope, evm_request_proof_slot(evm_request_id, PROOF_AMOUNT_OFFSET)),
        "stored EVM amount is too large"
    );
    eosio::check(stored_amount == static_cast<uint64_t>(quantity.amount), "EVM amount mismatch");

    auto stored_sender = read_evm_storage(evm_conf.evm_bridge_scope, evm_request_proof_slot(evm_request_id, PROOF_SENDER_OFFSET));
    eosio::check(padded_address_equals(stored_sender, evm_sender), "EVM sender mismatch");

    auto stored_receiver_hash = read_evm_storage(
        evm_conf.evm_bridge_scope,
        evm_request_proof_slot(evm_request_id, PROOF_ZERO_RECEIVER_HASH_OFFSET)
    );
    eosio::check(stored_receiver_hash == zero_receiver_hash(receiver), "Zero receiver mismatch");

    auto created_at = checksum256_to_uint64(
        read_evm_storage(evm_conf.evm_bridge_scope, evm_request_proof_slot(evm_request_id, PROOF_CREATED_AT_OFFSET)),
        "stored EVM timestamp is too large"
    );
    eosio::check(created_at > 0, "EVM request timestamp missing");
    if (evm_conf.finality_delay_sec > 0) {
        uint64_t now_sec = time_point_sec(eosio::current_time_point()).sec_since_epoch();
        eosio::check(created_at + evm_conf.finality_delay_sec <= now_sec, "EVM request is not past finality delay");
    }

    requests.emplace(get_self(), [&](auto& row) {
        row.request_id = requests.available_primary_key();
        row.evm_request_id = evm_request_id;
        row.pair_id = pair_id;
        row.receiver = receiver;
        row.quantity = quantity;
        row.evm_sender = evm_sender;
        row.processed_at = time_point_sec(eosio::current_time_point());
    });

    eosio::action(
        eosio::permission_level{get_self(), "active"_n},
        pair.token_contract,
        "issue"_n,
        std::make_tuple(receiver, quantity, string("EVM escrow proven"))
    ).send();
}

void zerobridge::refundztoe(uint64_t request_id, string reason) {
    require_admin();
    ztoe_table requests(get_self(), get_self().value);
    auto itr = requests.require_find(request_id, "request not found");
    eosio::check(!itr->refunded, "request already refunded");
    eosio::check(reason.size() <= 256, "reason has more than 256 bytes");

    pairs_table pairs(get_self(), get_self().value);
    auto pair = pairs.require_find(itr->pair_id, "pair not found");

    requests.modify(itr, eosio::same_payer, [&](auto& row) {
        row.refunded = true;
    });

    eosio::action(
        eosio::permission_level{get_self(), "active"_n},
        pair->token_contract,
        "issue"_n,
        std::make_tuple(itr->sender, itr->quantity, string("Zero-to-EVM refund: ") + reason)
    ).send();
}

void zerobridge::ontransfer(name from, name to, asset quantity, string memo) {
    if (from == get_self() || to != get_self()) return;

    auto conf = get_config();
    eosio::check(!conf.paused, "bridge is paused");
    check_evm_address_string(memo);

    auto pair = get_active_pair(get_first_receiver(), quantity.symbol);
    eosio::check(quantity.amount >= pair.min_quantity.amount, "quantity below minimum");
    eosio::check(quantity.amount <= pair.max_quantity.amount, "quantity above maximum");

    ztoe_table requests(get_self(), get_self().value);
    uint64_t request_id = requests.available_primary_key();
    checksum256 burn_id = make_burn_id(from, quantity, memo, request_id);

    requests.emplace(get_self(), [&](auto& row) {
        row.request_id = request_id;
        row.burn_id = burn_id;
        row.pair_id = pair.pair_id;
        row.sender = from;
        row.quantity = quantity;
        row.evm_receiver = memo;
        row.created_at = time_point_sec(eosio::current_time_point());
        row.refunded = false;
    });

    eosio::action(
        eosio::permission_level{get_self(), "active"_n},
        get_first_receiver(),
        "burn"_n,
        std::make_tuple(get_self(), quantity, string("Zero-to-EVM bridge burn"))
    ).send();
}

zerobridge::config_row zerobridge::get_config() {
    eosio::check(config.exists(), "bridge is not initialized");
    return config.get();
}

void zerobridge::require_admin() {
    require_auth(get_config().admin);
}

zerobridge::pair_row zerobridge::get_active_pair(name token_contract, symbol zero_symbol) const {
    pairs_table pairs(get_self(), get_self().value);
    auto by_token_symbol = pairs.get_index<"bytokensym"_n>();
    uint128_t token_symbol_key = (uint128_t(token_contract.value) << 64) | zero_symbol.raw();
    auto itr = by_token_symbol.require_find(token_symbol_key, "pair not found");
    eosio::check(itr->active, "pair is paused");
    return *itr;
}

zerobridge::pair_row zerobridge::get_active_pair(uint64_t pair_id) const {
    pairs_table pairs(get_self(), get_self().value);
    auto itr = pairs.require_find(pair_id, "pair not found");
    eosio::check(itr->active, "pair is paused");
    return *itr;
}

void zerobridge::check_evm_address_string(const string& value) {
    eosio::check(value.size() == 42, "EVM receiver must be a 42-character 0x address");
    eosio::check(value[0] == '0' && (value[1] == 'x' || value[1] == 'X'), "EVM receiver must start with 0x");
    for (uint32_t i = 2; i < value.size(); i++) {
        char c = value[i];
        bool is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        eosio::check(is_hex, "EVM receiver contains non-hex characters");
    }
}

checksum256 zerobridge::make_burn_id(name sender, asset quantity, const string& evm_receiver, uint64_t request_id) {
    auto packed = eosio::pack(std::make_tuple(sender, quantity, evm_receiver, request_id));
    return eosio::sha256(reinterpret_cast<const char*>(packed.data()), packed.size());
}

checksum256 zerobridge::evm_account::by_address() const {
    std::array<uint8_t, 32> output = {};
    auto address_bytes = address.extract_as_byte_array();
    std::copy(address_bytes.begin(), address_bytes.end(), output.begin() + 12);
    return checksum256(output);
}

zerobridge::evm_config_row zerobridge::get_evm_config() {
    eosio::check(evmconfig.exists(), "EVM bridge proof config is not set");
    return evmconfig.get();
}

checksum256 zerobridge::read_evm_storage(uint64_t evm_scope, checksum256 key) const {
    evm_account_state_table account_states(EVM_SYSTEM_CONTRACT, evm_scope);
    auto by_key = account_states.get_index<"bykey"_n>();
    auto row = by_key.find(key);
    if (row == by_key.end()) {
        std::array<uint8_t, 32> zero = {};
        return checksum256(zero);
    }
    return row->value;
}

checksum256 zerobridge::checksum160_to_padded_checksum256(checksum160 value) {
    std::array<uint8_t, 32> output = {};
    auto input = value.extract_as_byte_array();
    std::copy(input.begin(), input.end(), output.begin() + 12);
    return checksum256(output);
}

checksum256 zerobridge::evm_request_proof_base_slot(checksum256 evm_request_id) {
    std::array<uint8_t, 64> encoded = {};
    auto request_id_bytes = evm_request_id.extract_as_byte_array();
    std::copy(request_id_bytes.begin(), request_id_bytes.end(), encoded.begin());
    std::copy(REQUEST_PROOF_STORAGE_SLOT_BYTES.begin(), REQUEST_PROOF_STORAGE_SLOT_BYTES.end(), encoded.begin() + 32);
    return keccak256_bytes(encoded);
}

checksum256 zerobridge::evm_request_proof_slot(checksum256 evm_request_id, uint8_t offset) {
    return add_storage_slot_offset(evm_request_proof_base_slot(evm_request_id), offset);
}

checksum256 zerobridge::keccak256_bytes(const std::array<uint8_t, 64>& input) {
    std::array<uint8_t, 32> output = {};
    SHA3_CTX context;
    keccak_init(&context);
    keccak_update(&context, input.data(), input.size());
    keccak_final(&context, output.data());
    return checksum256(output);
}

checksum256 zerobridge::add_storage_slot_offset(checksum256 slot, uint8_t offset) {
    auto bytes = slot.extract_as_byte_array();
    uint16_t carry = offset;
    for (int i = 31; i >= 0 && carry > 0; --i) {
        uint16_t sum = static_cast<uint16_t>(bytes[i]) + carry;
        bytes[i] = static_cast<uint8_t>(sum & 0xff);
        carry = sum >> 8;
    }
    eosio::check(carry == 0, "storage slot offset overflow");
    return checksum256(bytes);
}

uint64_t zerobridge::checksum256_to_uint64(checksum256 value, const char* error_message) {
    auto bytes = value.extract_as_byte_array();
    for (uint8_t i = 0; i < 24; ++i) {
        eosio::check(bytes[i] == 0, error_message);
    }

    uint64_t output = 0;
    for (uint8_t i = 24; i < 32; ++i) {
        output = (output << 8) | bytes[i];
    }
    return output;
}

bool zerobridge::checksum256_is_one(checksum256 value) {
    auto bytes = value.extract_as_byte_array();
    for (uint8_t i = 0; i < 31; ++i) {
        if (bytes[i] != 0) return false;
    }
    return bytes[31] == 1;
}

bool zerobridge::padded_address_equals(checksum256 storage_word, checksum160 address) {
    auto word_bytes = storage_word.extract_as_byte_array();
    for (uint8_t i = 0; i < 12; ++i) {
        if (word_bytes[i] != 0) return false;
    }

    auto address_bytes = address.extract_as_byte_array();
    for (uint8_t i = 0; i < 20; ++i) {
        if (word_bytes[i + 12] != address_bytes[i]) return false;
    }
    return true;
}

checksum256 zerobridge::zero_receiver_hash(name receiver) {
    string value = receiver.to_string();
    return eosio::sha256(value.c_str(), value.size());
}

} // namespace zeroevm
