import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

function storage(initial={}) {
 const values=new Map(Object.entries(initial));
 return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
}
function checkoutHarness(fetchImpl) {
 const row={id:1,name:'Synthetic Shirt',category:'Shirts',price:10,stock:5,sizes:['M','L'],colors:['Black'],image:'https://example.test/image.png',description:'Synthetic'};
 const injected={0:[row],1:{name:'Buyer',email:'buyer@example.test',role:'customer'},2:[{id:1,qty:1,size:'M'}],
  21:true,24:{name:'Buyer',phone:'1234567',city:'Test',country:'Test',district:'Test',address:'Synthetic address',notes:''}};
 let stateIndex=0,tree;
 const memory=storage();
 const react={createElement:(type,props,...children)=>({type,props:props||{},children}),
  useRef:initial=>({current:initial}),useState:initial=>{
   const index=stateIndex++;const value=Object.hasOwn(injected,index)?injected[index]:(typeof initial==='function'?initial():initial);
   return [value,()=>{}];
  },useEffect:()=>{},useMemo:fn=>fn()};
 const source=ts.transpileModule(fs.readFileSync('src/main.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}
 }).outputText;
 const context={exports:{},require:name=>{
  if(name==='react')return {...react,default:react};
  if(name==='react-dom/client')return {createRoot:()=>({render:element=>{tree=element.type();}})};
  if(name.includes('lucide'))return new Proxy({},{get:()=>()=>null});
  if(name==='./data')return {categories:['All','Shirts'],seedProducts:[]};
  return {};
 },document:{getElementById:()=>({})},window:{scrollTo:()=>{}},localStorage:storage(),sessionStorage:memory,
 crypto:{subtle:crypto.webcrypto.subtle,randomUUID:crypto.randomUUID},TextEncoder,fetch:fetchImpl,
 setTimeout:()=>0,clearTimeout:()=>{}};
 vm.runInNewContext(source,context);
 const find=node=>{
  if(!node||typeof node!=='object')return null;
  if(node.type==='form'&&node.props.onSubmit?.name==='placeOrder')return node.props.onSubmit;
  for(const child of node.children||[]){if(Array.isArray(child)){for(const c of child){const found=find(c);if(found)return found;}}else{const found=find(child);if(found)return found;}}
  return null;
 };
 const submit=find(tree);assert.equal(typeof submit,'function');
 return {submit:()=>submit({preventDefault(){}}),memory};
}
test('actual checkout code reuses idempotency key after transport failure without persisting delivery details',async()=>{
 const calls=[];
 const h=checkoutHarness(async(url,options)=>{
  calls.push(options);
  if(calls.length===1)throw Error('synthetic network failure');
  return {ok:true,json:async()=>({order:{id:'WS-TEST',total:15}})};
 });
 await h.submit();
 const pending=JSON.parse(h.memory.getItem('ws_checkout_attempt'));
 assert.deepEqual(Object.keys(pending).sort(),['fingerprint','key']);
 await h.submit();
 assert.equal(calls.length,2);
 assert.ok(calls[0].headers['Idempotency-Key']===calls[1].headers['Idempotency-Key']);
 assert.equal(h.memory.getItem('ws_checkout_attempt'),null);
 assert.ok(!('total'in JSON.parse(calls[0].body)));
});
test('actual checkout code blocks duplicate in-flight submissions',async()=>{
 let calls=0,release;
 const h=checkoutHarness(async()=>{calls++;return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({order:{id:'WS-TEST'}})}));});
 const first=h.submit(),second=h.submit();
 for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1);release();
 await Promise.all([first,second]);
});
test('actual admin script uses cookies and does not claim logout succeeded on server failure',async()=>{
 const elements=new Map();const get=id=>{
  if(!elements.has(id))elements.set(id,{value:'',hidden:false,style:{},dataset:{},reset(){}});
  return elements.get(id);
 };
 let logoutFails=true,reloads=0;
 const calls=[];
 const memory=storage({wehliye_owner_token:'legacy-token'});
 const script=fs.readFileSync('admin.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 const context={document:{getElementById:get,querySelectorAll:()=>[]},sessionStorage:memory,
  setTimeout:()=>0,window:{scrollTo(){}},location:{reload:()=>reloads++},alert(){},confirm:()=>false,
  fetch:async(url,options)=>{
   calls.push({url,options});
   if(url==='/api/admin/me')return {ok:false,json:async()=>({error:'Sign in required'})};
   if(url==='/api/admin/logout'&&logoutFails)return {ok:false,json:async()=>({error:'Unavailable'})};
   return {ok:true,json:async()=>url==='/api/store'?{products:[],content:{}}:{ok:true}};
  }};
 vm.runInNewContext(script,context);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(memory.getItem('wehliye_owner_token'),null);
 get('username').value='test-owner';get('password').value='synthetic-password-only';
 await get('loginForm').onsubmit({preventDefault(){}});
 assert.equal(get('dashboard').style.display,'block');assert.equal(get('password').value,'');
 assert.ok(calls.every(c=>!('Authorization'in(c.options?.headers||{}))));
 await get('logout').onclick();assert.equal(reloads,0);assert.match(get('message').textContent,/failed/i);
 logoutFails=false;await get('logout').onclick();assert.equal(reloads,1);
});
