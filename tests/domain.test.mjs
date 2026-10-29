import test from 'node:test';
import assert from 'node:assert/strict';
import {placeOrder,changeOrderStatus,expireReservations,normalizeOrder,validateProduct,cents} from '../backend/store.mjs';
import {cookies} from '../backend/auth.mjs';
import {requireOrigin,clientAddress} from '../backend/security.mjs';
import {databaseConfig,validateProduction} from '../deployment-config.mjs';

const customer={googleSub:'synthetic-customer',email:'buyer@example.test',name:'Synthetic Buyer'};
const product=()=>({id:1,name:'Synthetic Shirt',price:10.10,stock:5,sizes:['M','L'],colors:['Black'],image:'https://example.test/photo.png',category:'Shirts'});
const state=()=>({products:[product()],content:{headline:'Test'},orders:[],customers:[]});
const input=items=>({items:items||[{id:1,qty:1,size:'M'}],country:'Test',city:'Test City',address:'Test address',phone:'1234567'});
const key='test-checkout-key-12345678';

test('aggregate stock rejects duplicate product lines and different sizes without deductions',()=>{
 for(const sizes of [['M','M'],['M','L']]){
  const d=state();assert.throws(()=>placeOrder(d,customer,input(sizes.map(size=>({id:1,qty:4,size}))),key),e=>e.status===409);
  assert.equal(d.products[0].stock,5);assert.equal(d.orders.length,0);
 }
});
test('server prices use integer cents, ignore client totals and preserve unpaid status',()=>{
 const d=state();const result=placeOrder(d,customer,{...input(),total:0,payment:'PAID',price:0},key);
 assert.equal(result.order.totalCents,1510);assert.equal(result.order.total,15.10);
 assert.match(result.order.payment,/UNPAID/);assert.equal(result.order.items[0].unitPriceCents,1010);
});
test('idempotent retry returns same order; changed payload conflicts',()=>{
 const d=state(),first=placeOrder(d,customer,input(),key);
 assert.equal(placeOrder(d,customer,input(),key).order.id,first.order.id);
 assert.equal(d.products[0].stock,4);assert.equal(d.orders.length,1);
 assert.throws(()=>placeOrder(d,customer,input([{id:1,qty:2,size:'M'}]),key),e=>e.status===409);
});
test('cancellation restores stock exactly once and cannot reopen',()=>{
 const d=state(),{order}=placeOrder(d,customer,input(),key);
 changeOrderStatus(d,order.id,'Cancelled');changeOrderStatus(d,order.id,'Cancelled');
 assert.equal(d.products[0].stock,5);
 assert.throws(()=>changeOrderStatus(d,order.id,'Confirmed'),e=>e.status===409);
});
test('expired reservation releases stock once; confirmed reservation does not expire',()=>{
 const d=state(),now=1000000,{order}=placeOrder(d,customer,input(),key,now);
 assert.equal(expireReservations(d,now+30*60000),true);
 assert.equal(expireReservations(d,now+31*60000),false);assert.equal(d.products[0].stock,5);
 const second=placeOrder(d,customer,input(),'second-checkout-key-12345',now+32*60000).order;
 changeOrderStatus(d,second.id,'Confirmed',now+33*60000);
 assert.equal(expireReservations(d,now+90*60000),false);assert.equal(d.products[0].stock,4);
 assert.equal(order.status,'Cancelled');
});
test('delivery and limits are server-controlled',()=>{
 const d=state();d.products[0].price=150;
 assert.equal(placeOrder(d,customer,input(),key).order.deliveryCents,0);
 for(const qty of [0,-1,1.5,21,'2',null])assert.throws(()=>normalizeOrder(input([{id:1,qty,size:'M'}])));
 assert.throws(()=>normalizeOrder(null));assert.throws(()=>normalizeOrder(input([null])));
 assert.throws(()=>placeOrder(state(),customer,input(),'short'));
});
test('rejects malformed product updates and invalid money',()=>{
 for(const price of [0,-1,Infinity,NaN,1.001,'10'])assert.throws(()=>cents(price));
 assert.equal(cents(10.1),1010);
 assert.throws(()=>validateProduct({...product(),sizes:[{}]}));
 assert.throws(()=>validateProduct({...product(),image:'javascript:alert(1)'}));
 assert.throws(()=>validateProduct({...product(),stock:-1}));
 assert.equal(validateProduct(product()).name,'Synthetic Shirt');
});
test('cookie parsing tolerates malformed encodings; origin checks are strict',()=>{
 assert.equal(cookies({headers:{cookie:'x=%zz; valid=hello'}}).valid,'hello');
 assert.throws(()=>requireOrigin({headers:{origin:'https://evil.test'}},'https://store.test'),e=>e.status===403);
 assert.throws(()=>requireOrigin({headers:{}},'https://store.test'));
 requireOrigin({headers:{origin:'https://store.test','sec-fetch-site':'same-origin'}},'https://store.test');
 const req={headers:{'x-forwarded-for':'spoofed, verified'},socket:{remoteAddress:'proxy'}};
 assert.equal(clientAddress(req),'proxy');assert.equal(clientAddress(req,1),'verified');
});
test('production variables and external database TLS fail safely',()=>{
 assert.throws(()=>databaseConfig({NODE_ENV:'production'}));
 const external=databaseConfig({DATABASE_URL:'postgresql://test:test@dpg-test.frankfurt-postgres.render.com/test?sslmode=disable'});
 assert.equal(external.ssl.rejectUnauthorized,true);assert.equal(new URL(external.connectionString).searchParams.has('sslmode'),false);
 const env={NODE_ENV:'production',ADMIN_USER:'owner',ADMIN_PASSWORD:'synthetic-password-only',PUBLIC_URL:'https://store.test',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test'};
 validateProduction(env);
 for(const PUBLIC_URL of ['http://store.test','https://store.test/','https://store.test/path'])assert.throws(()=>validateProduction({...env,PUBLIC_URL}));
 assert.throws(()=>validateProduction({...env,GOOGLE_CLIENT_SECRET:''}));
});
