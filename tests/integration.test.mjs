import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import {createApp,maintenance} from '../backend/app.mjs';
import {transaction,updateState,readState,placeOrder,changeOrderStatus,hash} from '../backend/store.mjs';
import {createSession,session,consumeOAuth} from '../backend/auth.mjs';

const url=process.env.TEST_DATABASE_URL,marker=process.env.TEST_CLUSTER_MARKER;
const fixture=()=>({products:[{id:1,name:'Synthetic Shirt',price:10.10,stock:5,sizes:['M','L'],colors:['Black'],image:'https://example.test/photo.png',category:'Shirts'}],
 content:{headline:'Synthetic store'},orders:[],customers:[]});
const buyer={googleSub:'test-buyer',name:'Test Buyer',email:'buyer@example.test'};
const input=(qty=1,size='M')=>({items:[{id:1,qty,size}],country:'Test',city:'Test City',address:'Synthetic address',phone:'1234567'});
const origin='https://store.test';
function cookieHeader(response) {return response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('isolated PostgreSQL integration', {skip:!url||!marker}, async t=>{
 const u=new URL(url);
 const proof=JSON.parse(fs.readFileSync(marker,'utf8'));
 assert.ok(u.hostname==='127.0.0.1'&&u.pathname==='/wehliye_security_test'&&Number(u.port)===proof.port);
 assert.ok(path.resolve(proof.data).startsWith(path.resolve('.test-postgres')+path.sep));
 assert.ok(fs.existsSync(path.join(proof.data,'PG_VERSION')));
 const pool=new pg.Pool({connectionString:url,max:10,connectionTimeoutMillis:5000});
 const otherPool=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
 const errors=[];let providerMode='ok',tokenCalls=0,lastVerifier='';
 const fakeGoogle=async(endpoint,options)=>{
  if(providerMode==='offline')throw Error('synthetic provider failure');
  if(endpoint.includes('/token')){
   tokenCalls++;lastVerifier=options.body.get('code_verifier');
   return {ok:true,json:async()=>({access_token:'synthetic-access-token'})};
  }
  return {ok:true,json:async()=>({sub:'oauth-test-buyer',name:'OAuth Test',email:'oauth@example.test',email_verified:providerMode!=='unverified'})};
 };
 const makeServer=p=>createApp({pool:p,root:process.cwd(),publicUrl:origin,adminUser:'test-owner',
  adminPassword:'synthetic-password-only',googleClient:'synthetic-client',googleSecret:'synthetic-secret',
  fetchImpl:fakeGoogle,logger:{error:v=>errors.push(v)}});
 let app=makeServer(pool),other=makeServer(otherPool);
 let base,second;
 try{
  await pool.query(fs.readFileSync('database.sql','utf8'));
  await pool.query('INSERT INTO public.store_state(id,data) VALUES(1,$1::jsonb)',[JSON.stringify(fixture())]);
  const before=(await pool.query('SELECT md5(data::text) AS hash FROM public.store_state WHERE id=1')).rows[0].hash;
  const schema=fs.readFileSync('migrations/001-auth.sql','utf8');
  await pool.query(schema);await pool.query(schema);
  assert.equal((await pool.query('SELECT md5(data::text) AS hash FROM public.store_state WHERE id=1')).rows[0].hash,before);
  base=await listen(app);second=await listen(other);
  const customerLogin=await transaction(pool,c=>createSession(c,'customer',buyer));
  const customerCookie='ws_customer='+customerLogin.token;
  const reset=async()=>pool.query('UPDATE public.store_state SET data=$1::jsonb WHERE id=1',[JSON.stringify(fixture())]);
  const request=(target,route,{method='GET',data,raw,headers={},cookie=''}={})=>fetch(target+route,{
    method,headers:{...(method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},
    body:raw??(data===undefined?undefined:JSON.stringify(data)),redirect:'manual',signal:AbortSignal.timeout(10000)});
  const checkout=(target,key='checkout-test-key-123456',data=input())=>request(target,'/api/orders',{
   method:'POST',cookie:customerCookie,data,headers:{'Idempotency-Key':key}});
  await t.test('authentication schema is additive and idempotent; readiness is healthy',async()=>{
   assert.equal((await request(base,'/health/ready')).status,200);
   const r=await request(base,'/');assert.equal(r.status,200);
   assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
   assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  });
  await t.test('session storage contains a hash, not a raw token; second process authenticates',async()=>{
   const stored=(await pool.query("SELECT token_hash FROM public.wehliye_sessions WHERE profile->>'googleSub'=$1",[buyer.googleSub])).rows[0];
   assert.ok(stored.token_hash===hash(customerLogin.token)&&stored.token_hash!==customerLogin.token);
   const r=await request(second,'/api/auth/me',{cookie:customerCookie});
   assert.equal((await r.json()).user.email,buyer.email);
   assert.equal((await request(base,'/api/admin/me',{cookie:customerCookie})).status,401);
  });
  await t.test('session survives an actual server object restart',async()=>{
   await close(app);app=makeServer(pool);base=await listen(app);
   const r=await request(base,'/api/auth/me',{cookie:customerCookie});assert.equal((await r.json()).user.email,buyer.email);
  });
  await t.test('last-item race across independent pools cannot oversell or lose orders',async()=>{
   await reset();await pool.query("UPDATE public.store_state SET data=jsonb_set(data,'{products,0,stock}','1') WHERE id=1");
   const results=await Promise.all([checkout(base,'last-item-key-111111111'),checkout(second,'last-item-key-222222222')]);
   assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
   const d=await readState(pool);assert.equal(d.products[0].stock,0);assert.equal(d.orders.length,1);
  });
  await t.test('simultaneous checkout retries create exactly one order',async()=>{
   await reset();const results=await Promise.all([checkout(base),checkout(second)]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
   const d=await readState(pool);assert.equal(d.orders.length,1);assert.equal(d.products[0].stock,4);
   assert.equal((await checkout(base,'checkout-test-key-123456',input(2))).status,409);
   const publicResponse=await (await checkout(base)).json();
   assert.ok(!('requestHash'in publicResponse.order)&&!('idempotencyKey'in publicResponse.order));
  });
  await t.test('duplicate product sizes cannot bypass combined inventory',async()=>{
   await reset();const payload={...input(),items:[{id:1,qty:4,size:'M'},{id:1,qty:4,size:'L'}]};
   assert.equal((await checkout(base,'aggregate-stock-key-1111',payload)).status,409);
   const d=await readState(pool);assert.equal(d.products[0].stock,5);assert.equal(d.orders.length,0);
  });
  await t.test('concurrent admin-style content and checkout updates both survive',async()=>{
   await reset();
   await Promise.all([updateState(pool,async d=>{d.content.headline='Updated';await new Promise(r=>setTimeout(r,40));}),
    updateState(otherPool,d=>placeOrder(d,buyer,input(),'concurrent-admin-key-1234'))]);
   const d=await readState(pool);assert.equal(d.content.headline,'Updated');assert.equal(d.orders.length,1);assert.equal(d.products[0].stock,4);
  });
  await t.test('transaction failure rolls back stock and auth writes together',async()=>{
   await reset();const prior=await readState(pool);
   await assert.rejects(updateState(pool,async(d,c)=>{
    d.products[0].stock=0;await createSession(c,'customer',{googleSub:'rollback-only'});
    throw Error('synthetic rollback');
   }));
   assert.deepEqual(await readState(pool),prior);
   const r=await pool.query("SELECT count(*)::int AS n FROM public.wehliye_sessions WHERE profile->>'googleSub'='rollback-only'");
   assert.equal(r.rows[0].n,0);
  });
  await t.test('parallel cancellation restores stock exactly once; cancelled orders stay final',async()=>{
   await reset();const placed=await updateState(pool,d=>placeOrder(d,buyer,input(2),'cancel-checkout-key-12345'));
   await Promise.all([updateState(pool,d=>changeOrderStatus(d,placed.order.id,'Cancelled')),
    updateState(otherPool,d=>changeOrderStatus(d,placed.order.id,'Cancelled'))]);
   assert.equal((await readState(pool)).products[0].stock,5);
   await assert.rejects(updateState(pool,d=>changeOrderStatus(d,placed.order.id,'Confirmed')),e=>e.status===409);
  });
  await t.test('expiry maintenance releases unpaid stock once without altering confirmed stock',async()=>{
   await reset();
   const expired=await updateState(pool,d=>placeOrder(d,buyer,input(),'expiry-checkout-key-12345',Date.now()-31*60000));
   await maintenance(pool);await maintenance(otherPool);
   let d=await readState(pool);assert.equal(d.products[0].stock,5);assert.equal(d.orders[0].status,'Cancelled');
   const placed=await updateState(pool,d=>placeOrder(d,buyer,input(),'confirm-checkout-key-1234'));
   await updateState(pool,d=>changeOrderStatus(d,placed.order.id,'Confirmed'));
   await maintenance(pool);d=await readState(pool);assert.equal(d.products[0].stock,4);
   assert.equal(d.orders.find(o=>o.id===expired.order.id).stockReleased,true);
  });
  await t.test('CSRF, missing auth/key, invalid JSON, wrong content type, large payload are rejected',async()=>{
   await reset();
   assert.equal((await request(base,'/api/orders',{method:'POST',data:input()})).status,401);
   assert.equal((await request(base,'/api/orders',{method:'POST',data:input(),cookie:customerCookie,headers:{Origin:'https://evil.test'}})).status,403);
   assert.equal((await request(base,'/api/orders',{method:'POST',data:input(),cookie:customerCookie,headers:{Origin:''}})).status,403);
   assert.equal((await request(base,'/api/orders',{method:'POST',data:input(),cookie:customerCookie})).status,400);
   assert.equal((await request(base,'/api/orders',{method:'POST',raw:'{',cookie:customerCookie})).status,400);
   assert.equal((await request(base,'/api/orders',{method:'POST',raw:'{}',cookie:customerCookie,headers:{'Content-Type':'text/plain'}})).status,415);
   assert.equal((await request(base,'/api/orders',{method:'POST',raw:JSON.stringify({padding:'x'.repeat(65000)}),cookie:customerCookie})).status,413);
   assert.equal((await readState(pool)).orders.length,0);
  });
  await t.test('slow request body does not hold a store lock or global queue',async()=>{
   await reset();
   const socket=net.connect(new URL(base).port,'127.0.0.1');
   await new Promise(resolve=>socket.once('connect',resolve));
   socket.write('POST /api/orders HTTP/1.1\r\nHost: store.test\r\nOrigin: '+origin+'\r\nCookie: '+customerCookie+'\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
   try{
    const response=await checkout(second,'slow-body-check-key-12345');assert.equal(response.status,201);
   }finally{socket.destroy();}
  });
  async function startOAuth(){
   const r=await request(base,'/api/auth/google');
   assert.equal(r.status,302);
   return {r,location:new URL(r.headers.get('location')),cookie:cookieHeader(r)};
  }
  await t.test('OAuth is browser-bound, PKCE protected, and consumable once across servers',async()=>{
   await reset();const flow=await startOAuth(),state=flow.location.searchParams.get('state');
   assert.equal(flow.location.searchParams.get('code_challenge_method'),'S256');
   assert.equal(flow.location.searchParams.get('redirect_uri'),origin+'/api/auth/google/callback');
   const callback='/api/auth/google/callback?state='+state+'&code=synthetic-code';
   const beforeCalls=tokenCalls;
   assert.equal((await request(second,callback)).status,400);assert.equal(tokenCalls,beforeCalls);
   const success=await request(second,callback,{cookie:flow.cookie});
   assert.equal(success.status,302);
   assert.ok(success.headers.getSetCookie().some(c=>c.startsWith('ws_customer=')&&c.includes('HttpOnly')&&c.includes('Secure')));
   assert.equal(crypto.createHash('sha256').update(lastVerifier).digest('base64url'),flow.location.searchParams.get('code_challenge'));
   assert.equal((await request(base,callback,{cookie:flow.cookie})).status,400);
   const me=await request(base,'/api/auth/me',{cookie:cookieHeader(success)});
   assert.equal((await me.json()).user.email,'oauth@example.test');
  });
  await t.test('OAuth state expiry and concurrent replay permit no double consumption',async()=>{
   const flow=await startOAuth(),state=flow.location.searchParams.get('state');
   const browser=flow.cookie.split('; ').find(c=>c.startsWith('ws_oauth_browser=')).split('=')[1];
   const outcomes=await Promise.allSettled([consumeOAuth(pool,state,browser),consumeOAuth(otherPool,state,browser)]);
   assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
   const expired=await startOAuth();
   await pool.query("UPDATE public.wehliye_oauth_states SET expires_at=NOW()-INTERVAL '1 second' WHERE state_hash=$1",[hash(expired.location.searchParams.get('state'))]);
   assert.equal((await request(base,'/api/auth/google/callback?state='+expired.location.searchParams.get('state')+'&code=test',{cookie:expired.cookie})).status,400);
  });
  await t.test('Google denial, provider failure and unverified email never authenticate',async()=>{
   for(const mode of ['denied','offline','unverified']){
    providerMode=mode;const flow=await startOAuth(),state=flow.location.searchParams.get('state');
    const callback='/api/auth/google/callback?state='+state+(mode==='denied'?'&error=access_denied':'&code=test');
    const r=await request(base,callback,{cookie:flow.cookie});
    assert.equal(r.status,mode==='offline'?502:401);
    assert.ok(!r.headers.getSetCookie().some(c=>c.startsWith('ws_customer=')));
   }
   providerMode='ok';
  });
  await t.test('admin cookies authenticate across servers; logout revokes; tokens are not returned',async()=>{
   const login=await request(base,'/api/admin/login',{method:'POST',data:{username:'test-owner',password:'synthetic-password-only'}});
   assert.equal(login.status,200);assert.deepEqual(await login.json(),{ok:true});
   const cookie=cookieHeader(login);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
   assert.equal((await request(second,'/api/admin/me',{cookie})).status,200);
   assert.equal((await request(base,'/api/admin/logout',{method:'POST',cookie,data:{}})).status,200);
   assert.equal((await request(second,'/api/admin/me',{cookie})).status,401);
  });
  await t.test('customer expiry and logout revoke authentication across processes',async()=>{
   const expired=await transaction(pool,c=>createSession(c,'customer',buyer));
   await pool.query("UPDATE public.wehliye_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1",[hash(expired.token)]);
   assert.equal(await session(otherPool,expired.token,'customer'),null);
   assert.equal((await request(base,'/api/auth/logout',{method:'POST',cookie:customerCookie,data:{}})).status,200);
   const me=await request(second,'/api/auth/me',{cookie:customerCookie});assert.equal((await me.json()).user,null);
  });
  await t.test('admin brute force is rate limited across processes and errors omit secrets',async()=>{
   let limited=false;
   for(let i=0;i<11;i++){
    const r=await request(i%2?second:base,'/api/admin/login',{method:'POST',data:{username:'test-owner',password:'wrong'}});
    if(r.status===429){limited=true;assert.ok(r.headers.get('retry-after'));break;}
    assert.equal(r.status,401);
   }
   assert.equal(limited,true);
   assert.ok(errors.every(e=>!e.includes('synthetic-secret')&&!e.includes('synthetic-password')));
  });
 }finally{
  if(app.listening)await close(app);if(other.listening)await close(other);
  await pool.end();await otherPool.end();
 }
});
