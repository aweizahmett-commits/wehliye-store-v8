import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/app.mjs';
test('unexpected database failures never expose error messages, credentials or SQL',async()=>{
 const logs=[];
 const pool={query:async()=>{const e=Error('postgresql://private-password@private-host SQL SELECT secret');e.code='08006';throw e;}};
 const server=createApp({pool,root:process.cwd(),publicUrl:'http://store.test',
  adminUser:'test',adminPassword:'synthetic-password-only',logger:{error:v=>logs.push(v)}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/store');
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'Service temporarily unavailable'});
  assert.equal(logs.length,1);assert.deepEqual(JSON.parse(logs[0]),{event:'request_failed',code:'08006'});
  const ready=await fetch('http://127.0.0.1:'+server.address().port+'/health/ready');
  assert.equal(ready.status,503);assert.deepEqual(await ready.json(),{status:'not_ready'});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
