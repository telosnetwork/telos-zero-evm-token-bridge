const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {Api,Numeric}=require('eosjs');
const {JsSignatureProvider}=require('eosjs/dist/eosjs-jssig.js');

test('CLI regressions: isolation, durable discovery/retry, dry-run, cancellation, and native relay',async t=>{
 const root=path.resolve(__dirname,'../..');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-relayer-test-'));
 const localKey=Numeric.privateKeyToString({type:Numeric.KeyType.k1,data:Uint8Array.from({length:32},()=>1)});
 const signatureProvider=new JsSignatureProvider([localKey]);
 const publicKeys=await signatureProvider.getAvailableKeys();
 const structs=[
  {name:'proveetoz',base:'',fields:[{name:'pair_id',type:'uint64'},{name:'evm_request_id',type:'checksum256'},{name:'receiver',type:'name'},{name:'quantity',type:'asset'},{name:'evm_sender',type:'checksum160'}]},
  {name:'relayztoe',base:'',fields:[{name:'request_id',type:'uint64'}]},
  {name:'refundetoz',base:'',fields:[{name:'evm_request_number',type:'uint64'},{name:'evm_request_id',type:'checksum256'}]}
 ];
 const abi={version:'eosio::abi/1.2',types:[],structs,actions:structs.map(s=>({name:s.name,type:s.name,ricardian_contract:''})),tables:[],ricardian_clauses:[],error_messages:[],abi_extensions:[],variants:[]};
 const rawAbi=Buffer.from(new Api({rpc:{},signatureProvider}).jsonToRawAbi(abi)).toString('base64');
 const zeroHash='00'.repeat(32),word=n=>BigInt(n).toString(16).padStart(64,'0');
 const sender='11'.repeat(20),bridge='0x'+'22'.repeat(20),token='0x'+'33'.repeat(20);
 const event=(receiver,id,block=7)=>({address:bridge,topics:['0xb4dcb091617ca075bed6d6570082906aca5caac3547bae851fc3a6e4cca0bccd','0x'+word(id),'0x'+word(1),'0x'+sender.padStart(64,'0')],
  data:'0x'+word(96)+word(1000000)+word(id)+word(Buffer.byteLength(receiver))+Buffer.from(receiver).toString('hex').padEnd(64,'0'),blockNumber:'0x'+block.toString(16),transactionHash:'0x'+word(id),logIndex:'0x0'});
 let logs=[],pushes=[],filters=[],head=10,ztoeRows=[],processed=new Set(),proofStatus=1,lastAction;
 const server=http.createServer(async(req,res)=>{
  try{
   let bytes='';for await(const chunk of req)bytes+=chunk;
   const b=bytes?JSON.parse(bytes):{};let reply;
   if(req.url==='/evm'){
    let result;
    if(b.method==='eth_chainId')result='0x29';
    else if(b.method==='eth_blockNumber')result='0x'+head.toString(16);
    else if(b.method==='eth_getStorageAt')result='0x'+word(proofStatus);
    else if(b.method==='eth_getLogs'){
     filters.push(b.params[0]);result=logs.filter(l=>BigInt(l.blockNumber)>=BigInt(b.params[0].fromBlock)&&BigInt(l.blockNumber)<=BigInt(b.params[0].toBlock));
    }else if(b.method==='eth_call')result='0x'+word(0);
    else throw new Error('unexpected EVM method '+b.method);
    reply={jsonrpc:'2.0',id:b.id,result};
   }else if(req.url.endsWith('/get_abi'))reply={account_name:'zerobridge',abi};
   else if(req.url.endsWith('/get_raw_abi'))reply={account_name:'zerobridge',abi_hash:zeroHash,code_hash:zeroHash,abi:rawAbi};
   else if(req.url.endsWith('/get_table_rows'))reply={rows:b.table==='ztoereqs'?ztoeRows:[...processed].map(evm_request_id=>({evm_request_id})),more:false};
   else if(req.url.endsWith('/get_info'))reply={chain_id:'41'.repeat(32),head_block_num:100,head_block_time:'2026-09-16T00:00:00.000',last_irreversible_block_num:98,last_irreversible_block_id:zeroHash};
   else if(req.url.endsWith('/get_block_info')||req.url.endsWith('/get_block'))reply={block_num:97,id:zeroHash,timestamp:'2026-09-16T00:00:00.000',ref_block_prefix:1};
   else if(req.url.endsWith('/get_required_keys')){lastAction=b.transaction.actions[0];reply={required_keys:publicKeys};}
   else if(req.url.endsWith('/push_transaction')){
    pushes.push(lastAction);
    if(lastAction.name==='proveetoz')processed.add(lastAction.data.slice(16,80));
    reply={transaction_id:'aa'.repeat(32),processed:{receipt:{status:'executed'}}};
   }else throw new Error('unexpected native endpoint '+req.url);
   res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 const config={evm:{rpcUrl:url+'/evm',chainId:41,escrowBridge:bridge,scanFromBlock:0,scanOverlapBlocks:0},zero:{apiUrl:url,bridgeAccount:'zerobridge',processorAction:'auto',authorization:{actor:'relayrunner',permission:'bridgeops'},zeroToEvmRelayMode:'auto',zeroToEvmAuthorization:{actor:'relayrunner',permission:'bridgeops'}},pairs:[{pairId:1,evmToken:token,evmDecimals:6,zeroDecimals:6,zeroContract:'zeroasset',zeroSymbol:'ZTOK'}]};
 const configFile=path.join(temp,'config.json'),stateFile=configFile+'.state.json';
 fs.writeFileSync(configFile,JSON.stringify(config));
 const state=()=>JSON.parse(fs.readFileSync(stateFile));
 const reset=()=>{fs.rmSync(stateFile,{force:true});logs=[];pushes=[];processed=new Set();head=10;proofStatus=1;filters=[];};
 const run=(file,args=[],env={})=>new Promise(resolve=>{
  const child=spawn(process.execPath,[path.join(root,'relayer/src',file),configFile,...args],{env:{PATH:process.env.PATH,ZERO_RELAYER_PRIVATE_KEY:localKey,...env}});
  let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.on('exit',code=>resolve({code,out}));
 });
 try{
  await t.test('poison request does not block later work and remains pending for recovery',async()=>{
   reset();logs=[event('ALICE!',1),event('alice',2)];
   let result=await run('process-evm-requests.js');assert.equal(result.code,1,result.out);assert.equal(pushes.length,1,result.out);
   assert.equal(Object.keys(state().pending).length,1);assert.equal(state().nextBlock,'0xb');
   head=20;result=await run('process-evm-requests.js');assert.equal(result.code,1);assert.equal(pushes.length,1);
   assert.equal(Object.values(state().pending)[0].attempts,2);
  });
  await t.test('pending request survives restart after scan cursor advances',async()=>{
   reset();logs=[event('alice',3)];proofStatus=0;
   assert.equal((await run('process-evm-requests.js')).code,1);assert.equal(pushes.length,0);
   assert.equal(Object.keys(state().pending).length,1);
   head=20;proofStatus=1;
   const result=await run('process-evm-requests.js');assert.equal(result.code,0,result.out);assert.equal(pushes.length,1);
   assert.equal(filters[1].fromBlock,'0xb');assert.deepEqual(state().pending,{});
  });
  await t.test('dry-run neither sends nor advances durable state',async()=>{
   reset();logs=[event('alice',4)];
   const result=await run('process-evm-requests.js',['--dry-run']);assert.equal(result.code,0,result.out);
   assert.equal(pushes.length,0);assert.equal(fs.existsSync(stateFile),false);
  });
  await t.test('default scanner finds historical events and rejects unsafe latest start',async()=>{
   reset();logs=[event('alice',5)];
   const {scanEvmRequests}=await import('../src/lib/scan.js');
   const scan=await scanEvmRequests({...config,evm:{...config.evm,scanFromBlock:undefined}});assert.equal(scan.count,1);
   await assert.rejects(scanEvmRequests({...config,evm:{...config.evm,scanFromBlock:'latest'}}),/fixed deployment block/);
  });
  await t.test('depositor cancellation dispatches native refund without validating old invalid receiver',async()=>{
   reset();logs=[event('ALICE!',6)];proofStatus=2;
   const result=await run('process-evm-requests.js');assert.equal(result.code,0,result.out);assert.equal(pushes[0].name,'refundetoz');
   assert.deepEqual(state().pending,{});
  });
  await t.test('documented native key signs relayztoe without any EVM key',async()=>{
   reset();ztoeRows=[{request_id:7,pair_id:1,quantity:'1.000000 ZTOK',sender:'alice',evm_receiver:'0x'+sender,burn_id:'ab'.repeat(32),refunded:false}];
   const result=await run('process-zero-requests.js',[],{ZERO_TO_EVM_RELAYER_PRIVATE_KEY:localKey});
   assert.equal(result.code,0,result.out);assert.equal(pushes[0].name,'relayztoe');assert.match(result.out,/"mode": "native"/);
  });
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
});
