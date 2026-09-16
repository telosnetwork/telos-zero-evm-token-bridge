const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Blockchain } = require('@proton/vert');
require('./compiler-builtins.cjs');
const { Name, TimePoint } = require('@greymass/eosio');
const { encodeAbiParameters, keccak256, sha256, stringToHex, fromRlp, decodeFunctionData, parseAbi } = require('viem');

const word = value => BigInt(value).toString(16).padStart(64, '0');
const addr = byte => byte.repeat(20);
const hash = byte => byte.repeat(32);
const proofBase = request => BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'}], ['0x'+request,'0xf981179bb6ca7bacd9c09fc7ee84e06aaea9dc6e23314fa01335b762685e87c1'])));
const burnSlot = burn => keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}], ['0x'+burn,6n])).slice(2);
const number = name => BigInt(Name.from(name).value.toString());

async function setup(delay = 0, decimals = 8) {
  const bc = new Blockchain({timestamp:TimePoint.fromMilliseconds(1000000)});
  for (const name of ['alice','bob','admin','relay']) bc.createAccount(name);
  const deploy = (name, artifact) => bc.createAccount({name,enableInline:true,
    wasm:fs.readFileSync(path.join(__dirname,'../build',artifact+'.wasm')),
    abi:fs.readFileSync(path.join(__dirname,'../build',artifact+'.abi'),'utf8')});
  const evm = deploy('eosio.evm','mock.evm');
  const bridge = deploy('zerobridge','zero.bridge');
  const token = deploy('zeroasset','zero.asset');
  await evm.actions.seedacct([1,addr('11'),'', [1]]).send('eosio.evm');
  await evm.actions.seedacct([2,addr('22'),'zerobridge', []]).send('eosio.evm');
  await bridge.actions.init(['admin','zerobridge',false]).send('zerobridge');
  await bridge.actions.setevmconf([addr('11'),delay]).send('admin');
  await bridge.actions.addpair([1,'zeroasset','6,ZTOK',addr('33'),decimals,'0.000001 ZTOK','10000.000000 ZTOK']).send('admin');
  await token.actions.create(['zerobridge','1000000.000000 ZTOK']).send('zeroasset');
  const balance = owner => token.tables.accounts(number(owner)).getTableRow(BigInt('0x4b4f545a'))?.balance;
  const supply = () => token.tables.stat(BigInt('0x4b4f545a')).getTableRow(BigInt('0x4b4f545a')).supply;
  const set = (key,value) => evm.actions.setstorage([1,key,value]).send('eosio.evm');
  async function proof(request, amount, state=1) {
    const fields = [word(1),word(amount),addr('44').padStart(64,'0'),sha256(stringToHex('alice')).slice(2),word(999),word(state)];
    for(let i=0;i<fields.length;i++) await set(word(proofBase(request)+BigInt(i)),fields[i]);
  }
  return {bc,evm,bridge,token,balance,supply,set,proof};
}

test('unequal-decimal proof rejects inflation, accepts normalization, and rejects replay',async()=>{
  const x=await setup(); const request=hash('aa'); await x.proof(request,100000000n);
  await assert.rejects(x.bridge.actions.proveetoz([1,request,'alice','100.000000 ZTOK',addr('44')]).send('relay'),/EVM amount mismatch/);
  await x.bridge.actions.proveetoz([1,request,'alice','1.000000 ZTOK',addr('44')]).send('relay');
  assert.equal(x.balance('alice'),'1.000000 ZTOK');
  await assert.rejects(x.bridge.actions.proveetoz([1,request,'alice','1.000000 ZTOK',addr('44')]).send('relay'),/already processed/);
});

test('positive finality delay creates a durable burn, then permits a verified payout',async()=>{
  const x=await setup(2);
  await x.token.actions.issue(['alice','5.000000 ZTOK','fixture']).send('zerobridge');
  await x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('55')]).send('alice');
  const row=x.bridge.tables.ztoereqs().getTableRow(0n);
  assert.equal(row.quantity,'1.000000 ZTOK'); assert.equal(x.supply(),'4.000000 ZTOK');
  await assert.rejects(x.bridge.actions.relayztoe([0]).send('relay'),/finality delay/);
  await x.evm.actions.setresult([1,burnSlot(row.burn_id),word(1),false]).send('eosio.evm');
  x.bc.setTime(TimePoint.fromMilliseconds(1002000));
  await x.bridge.actions.relayztoe([0]).send('relay');
  const status=x.bridge.tables.ztoestatus().getTableRow(0n);
  assert.equal(status.completed,true); assert.equal(status.dispatching,false);
  const raw=x.evm.tables.calls().getTableRow(number('calls'));
  const fields=fromRlp('0x'+raw.tx);
  const call=decodeFunctionData({abi:parseAbi(['function releaseToEvm(uint256,uint256,address,bytes32,string)']),data:fields[5]});
  assert.equal(call.args[1],100000000n); assert.equal(call.args[2].toLowerCase(),'0x'+addr('55'));
  assert.equal(call.args[4],'alice');
  await assert.rejects(x.bridge.actions.refundztoe([0,'recovery']).send('admin'),/dispatching or completed/);
  await assert.rejects(x.bridge.actions.relayztoe([0]).send('relay'),/already released/);
  assert.equal(x.supply(),'4.000000 ZTOK');
});

test('failed inline EVM payout rolls back burn, request, and raw side effects',async()=>{
  const x=await setup();
  await x.token.actions.issue(['alice','5.000000 ZTOK','fixture']).send('zerobridge');
  await x.evm.actions.setresult([1,hash('00'),word(0),true]).send('eosio.evm');
  await assert.rejects(x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('55')]).send('alice'),/EVM release failed/);
  assert.equal(x.balance('alice'),'5.000000 ZTOK'); assert.equal(x.supply(),'5.000000 ZTOK');
  assert.equal(x.bridge.tables.ztoereqs().getTableRow(0n),undefined);
  assert.equal(x.evm.tables.calls().getTableRow(number('calls')),undefined);
});

test('a legacy completed row cannot be refunded even without native completion status',async()=>{
  const x=await setup(1);
  await x.token.actions.issue(['alice','2.000000 ZTOK','fixture']).send('zerobridge');
  await x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('55')]).send('alice');
  const row=x.bridge.tables.ztoereqs().getTableRow(0n);
  await x.set(burnSlot(row.burn_id),word(1));
  await assert.rejects(x.bridge.actions.refundztoe([0,'stale recovery']).send('admin'),/already released/);
  assert.equal(x.supply(),'1.000000 ZTOK');
});

test('pending native refund is authorized, happens once, and excludes release',async()=>{
  const x=await setup(1);
  await x.token.actions.issue(['alice','2.000000 ZTOK','fixture']).send('zerobridge');
  await x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('55')]).send('alice');
  await assert.rejects(x.bridge.actions.refundztoe([0,'recovery']).send('alice'),/missing required authority|missing authority/i);
  await x.bridge.actions.refundztoe([0,'recovery']).send('admin');
  assert.equal(x.balance('alice'),'2.000000 ZTOK');
  await assert.rejects(x.bridge.actions.refundztoe([0,'repeat']).send('admin'),/already refunded/);
  await assert.rejects(x.bridge.actions.relayztoe([0]).send('relay'),/was refunded/);
});

test('cancellation requires depositor flag, excludes minted proofs, and verifies EVM result',async()=>{
  const x=await setup(); const request=hash('aa'); await x.proof(request,100000000n);
  await assert.rejects(x.bridge.actions.refundetoz([1,request]).send('relay'),/has not requested/);
  const statusSlot=word(proofBase(request)+5n);
  await x.set(statusSlot,word(2));
  await assert.rejects(x.bridge.actions.proveetoz([1,request,'alice','1.000000 ZTOK',addr('44')]).send('relay'),/proof not found/);
  await x.evm.actions.setresult([1,statusSlot,word(3),true]).send('eosio.evm');
  await assert.rejects(x.bridge.actions.refundetoz([1,request]).send('relay'),/EVM refund failed/);
  assert.equal(x.evm.tables.calls().getTableRow(number('calls')),undefined);
  await x.evm.actions.setresult([1,statusSlot,word(3),false]).send('eosio.evm');
  await x.bridge.actions.refundetoz([1,request]).send('relay');
  const raw=x.evm.tables.calls().getTableRow(number('calls'));
  const call=decodeFunctionData({abi:parseAbi(['function refundDeposit(uint256,bytes32)']),data:fromRlp('0x'+raw.tx)[5]});
  assert.equal(call.args[0],1n);assert.equal(call.args[1],'0x'+request);
  await assert.rejects(x.bridge.actions.refundetoz([1,request]).send('relay'),/has not requested/);
  const minted=hash('bb'); await x.proof(minted,100000000n);
  await x.bridge.actions.proveetoz([1,minted,'alice','1.000000 ZTOK',addr('44')]).send('relay');
  await x.set(word(proofBase(minted)+5n),word(2));
  await assert.rejects(x.bridge.actions.refundetoz([2,minted]).send('relay'),/already processed/);
});

test('zero receivers and re-enabling development minting are rejected',async()=>{
  const x=await setup();
  await x.token.actions.issue(['alice','2.000000 ZTOK','fixture']).send('zerobridge');
  await assert.rejects(x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('00')]).send('alice'),/zero address/);
  await assert.rejects(x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('11')]).send('alice'),/bridge address/);
  await assert.rejects(x.bridge.actions.setdevmode([true]).send('admin'),/cannot be re-enabled/);
  await x.evm.actions.seedacct([3,addr('66'),'', [1]]).send('eosio.evm');
  await assert.rejects(x.bridge.actions.setevmconf([addr('66'),0]).send('admin'),/identity is fixed/);
});

test('proof amounts above uint64 are supported without accepting uint128 overflow',async()=>{
  const x=await setup(0,30); const request=hash('aa'); await x.proof(request,10n**30n);
  await x.bridge.actions.proveetoz([1,request,'alice','1.000000 ZTOK',addr('44')]).send('relay');
  assert.equal(x.balance('alice'),'1.000000 ZTOK');
  const overflow=hash('bb'); await x.proof(overflow,1n<<128n);
  await assert.rejects(x.bridge.actions.proveetoz([1,overflow,'alice','1.000000 ZTOK',addr('44')]).send('relay'),/stored EVM amount is too large/);
});

test('repeated failed public retries preserve the pending burn and roll back raw effects',async()=>{
  const x=await setup(1);
  await x.token.actions.issue(['alice','2.000000 ZTOK','fixture']).send('zerobridge');
  await x.token.actions.transfer(['alice','zerobridge','1.000000 ZTOK','0x'+addr('55')]).send('alice');
  await x.evm.actions.setresult([1,hash('00'),word(0),true]).send('eosio.evm');
  x.bc.setTime(TimePoint.fromMilliseconds(1001000));
  for(let i=0;i<2;i++) {
    await assert.rejects(x.bridge.actions.relayztoe([0]).send('relay'),/EVM release failed/);
    assert.equal(x.evm.tables.calls().getTableRow(number('calls')),undefined);
    assert.equal(x.bridge.tables.ztoestatus().getTableRow(0n),undefined);
    assert.equal(x.bridge.tables.ztoereqs().getTableRow(0n).refunded,false);
    assert.equal(x.balance('alice'),'1.000000 ZTOK');
  }
});
