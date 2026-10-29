import 'dotenv/config';
import pg from 'pg';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const db = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||3001);
const adminUser=process.env.ADMIN_USER||'owner';
const adminPassword=process.env.ADMIN_PASSWORD;
if(!adminPassword || adminPassword.length<12){console.error('Set ADMIN_PASSWORD (12+ characters) before starting server.');process.exit(1)}
const sessions=new Map();
const customers=new Map();
const googleClient=process.env.GOOGLE_CLIENT_ID||'';
const googleSecret=process.env.GOOGLE_CLIENT_SECRET||'';
const publicUrl=process.env.PUBLIC_URL||`http://localhost:${port}`;
const secureCookie=publicUrl.startsWith('https:')?'; Secure':'';
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const customer=req=>{const token=cookies(req).ws_customer;const v=customers.get(token);return v&&v.exp>Date.now()?v:null};
const customerSessionsFile=path.join(root,'customer-sessions.json');
const loadCustomers=()=>{try{for(const [k,v] of Object.entries(JSON.parse(fs.readFileSync(customerSessionsFile,'utf8'))))if(v.exp>Date.now())customers.set(k,v)}catch{}};
const saveCustomers=()=>fs.writeFileSync(customerSessionsFile,JSON.stringify(Object.fromEntries(customers)));
loadCustomers();
const oauthStates=new Map();

const read=async()=>{const r=await db.query('SELECT data FROM store_state WHERE id=1');if(!r.rows.length)throw Error('Store state missing');const d=r.rows[0].data;d.orders??=[];d.customers??=[];return d};
const write=async data=>{const r=await db.query('UPDATE store_state SET data=$1::jsonb,updated_at=NOW() WHERE id=1',[JSON.stringify(data)]);if(r.rowCount!==1)throw Error('Store state update failed')};

let writeQueue=Promise.resolve();
async function lockWrite(){
  let release;
  const next=new Promise(resolve=>release=resolve);
  const previous=writeQueue;
  writeQueue=previous.then(()=>next);
  await previous;
  return release;
}
const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
const body=async req=>{let s='';for await(const c of req){s+=c;if(s.length>5_000_000)throw Error('Request too large')}return JSON.parse(s||'{}')};
const authorized=req=>{const token=(req.headers.authorization||'').replace(/^Bearer /,'');return !!sessions.get(token)&&sessions.get(token)>Date.now()};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');const pathname=url.pathname;
const changing=(req.method==='POST'&&pathname==='/api/orders')||(req.method==='GET'&&pathname==='/api/auth/google/callback')||(pathname.startsWith('/api/admin/')&&['POST','PUT','PATCH','DELETE'].includes(req.method));
let release;
try{
if(changing)release=await lockWrite();
if(req.method==='GET'&&pathname==='/api/store'){const d=await read();return send(res,200,{products:d.products,content:d.content})}
if(req.method==='GET'&&pathname==='/api/auth/me'){const c=customer(req);return send(res,200,{user:c?{name:c.name,email:c.email,role:'customer'}:null,googleEnabled:!!(googleClient&&googleSecret)})}
if(req.method==='GET'&&pathname==='/api/auth/google'){
 if(!googleClient||!googleSecret)return send(res,503,{error:'Google OAuth not configured. See README.'});
 const state=crypto.randomBytes(24).toString('hex');oauthStates.set(state,Date.now()+600000);
 const params=new URLSearchParams({client_id:googleClient,redirect_uri:publicUrl+'/api/auth/google/callback',response_type:'code',scope:'openid email profile',state,access_type:'online',prompt:'select_account'});
 res.writeHead(302,{Location:'https://accounts.google.com/o/oauth2/v2/auth?'+params});return res.end();
}
if(req.method==='GET'&&pathname==='/api/auth/google/callback'){
 const state=url.searchParams.get('state'),code=url.searchParams.get('code');if(!state||!code||!oauthStates.has(state)||oauthStates.get(state)<Date.now())return send(res,400,{error:'Invalid OAuth state'});oauthStates.delete(state);
 const t=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:googleClient,client_secret:googleSecret,redirect_uri:publicUrl+'/api/auth/google/callback',grant_type:'authorization_code'})});
 if(!t.ok)return send(res,401,{error:'Google token exchange failed'});const tokens=await t.json();
 const r=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+tokens.access_token}});if(!r.ok)return send(res,401,{error:'Google identity verification failed'});const profile=await r.json();if(!profile.sub||!profile.email||!profile.email_verified)return send(res,401,{error:'Google email not verified'});
 const d=await read();let c=d.customers.find(x=>x.googleSub===profile.sub);if(!c){c={googleSub:profile.sub,email:profile.email,name:profile.name||profile.email,createdAt:new Date().toISOString()};d.customers.push(c);await write(d)}
 const session=crypto.randomBytes(32).toString('hex');customers.set(session,{name:c.name,email:c.email,googleSub:c.googleSub,exp:Date.now()+7*86400000});saveCustomers();res.writeHead(302,{Location:'/', 'Set-Cookie':`ws_customer=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookie}`});return res.end();
}
if(req.method==='POST'&&pathname==='/api/auth/logout'){const token=cookies(req).ws_customer;customers.delete(token);saveCustomers();res.writeHead(200,{'Set-Cookie':`ws_customer=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,'Content-Type':'application/json'});return res.end('{"ok":true}')}
if(req.method==='GET'&&pathname==='/api/orders'){const c=customer(req);if(!c)return send(res,401,{error:'Google sign in required'});return send(res,200,{orders:(await read()).orders.filter(o=>o.googleSub===c.googleSub)})}
if(req.method==='POST'&&pathname==='/api/orders'){
 const c=customer(req);if(!c)return send(res,401,{error:'Google sign in required'});
 const input=await body(req);if(!Array.isArray(input.items)||input.items.length<1||input.items.length>50||typeof input.address!=='string'||input.address.trim().length<5||typeof input.city!=='string'||!input.city.trim()||typeof input.country!=='string'||!input.country.trim()||typeof input.phone!=='string'||input.phone.trim().length<5)return send(res,400,{error:'Valid items, country, city, address and phone required'});
 const d=await read(),lines=[];let subtotal=0;
 for(const x of input.items){const p=d.products.find(p=>p.id===Number(x.id)),qty=Number(x.qty);if(!p||!Number.isInteger(qty)||qty<1||qty>20||p.stock<qty||!p.sizes.includes(x.size))return send(res,400,{error:'Invalid item, size, or insufficient stock'});lines.push({id:p.id,name:p.name,size:x.size,qty,unitPrice:p.price});subtotal+=p.price*qty}
 const delivery=subtotal>=150?0:5;const order={id:'WS-'+crypto.randomBytes(5).toString('hex').toUpperCase(),googleSub:c.googleSub,user:c.email,items:lines,total:Math.round((subtotal+delivery)*100)/100,country:input.country.slice(0,100),city:input.city.slice(0,100),address:input.address.slice(0,600),phone:input.phone.slice(0,60),payment:'UNPAID â€” manual confirmation required',status:'Awaiting payment',date:new Date().toISOString()};
 for(const x of lines)d.products.find(p=>p.id===x.id).stock-=x.qty;d.orders.unshift(order);await write(d);return send(res,201,{order});
}

if(req.method==='POST'&&pathname==='/api/admin/login'){
const v=await body(req);const equal=(a,b)=>{const x=crypto.createHash('sha256').update(String(a)).digest(),y=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(x,y)};
if(!equal(v.username,adminUser)||!equal(v.password,adminPassword))return send(res,401,{error:'Invalid admin credentials'});
const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+8*3600_000);return send(res,200,{token});}
if(pathname.startsWith('/api/admin/')){
if(!authorized(req))return send(res,401,{error:'Admin login required'});
if(req.method==='GET'&&pathname==='/api/admin/orders')return send(res,200,{orders:(await read()).orders});
if(req.method==='GET'&&pathname==='/api/admin/customers')return send(res,200,{customers:(await read()).customers});
const om=pathname.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)$/);if(om&&req.method==='PATCH'){const v=await body(req);const allowed=['Awaiting payment','Confirmed','Processing','Shipped','Delivered','Cancelled'];if(!allowed.includes(v.status))return send(res,400,{error:'Invalid status'});const d=await read(),o=d.orders.find(x=>x.id===om[1]);if(!o)return send(res,404,{error:'Order not found'});o.status=v.status;await write(d);return send(res,200,{order:o})}
if(req.method==='POST'&&pathname==='/api/admin/logout'){sessions.delete((req.headers.authorization||'').replace(/^Bearer /,''));return send(res,200,{ok:true})}
if(req.method==='PUT'&&pathname==='/api/admin/content'){const input=await body(req),d=await read();for(const k of Object.keys(d.content))if(typeof input[k]==='string')d.content[k]=input[k].slice(0,500);await write(d);return send(res,200,d.content)}
if(req.method==='POST'&&pathname==='/api/admin/products'){const p=await body(req);if(!valid(p))return send(res,400,{error:'Invalid product'});const d=await read();const product={...p,id:Date.now(),price:Number(p.price),stock:Number(p.stock)};d.products.unshift(product);await write(d);return send(res,200,product)}
const match=pathname.match(/^\/api\/admin\/products\/(\d+)$/);if(match){const id=Number(match[1]),d=await read(),i=d.products.findIndex(p=>p.id===id);if(i<0)return send(res,404,{error:'Not found'});if(req.method==='DELETE'){d.products.splice(i,1);await write(d);return send(res,200,{ok:true})}if(req.method==='PUT'){const p=await body(req);if(!valid(p))return send(res,400,{error:'Invalid product'});d.products[i]={...p,id,price:Number(p.price),stock:Number(p.stock)};await write(d);return send(res,200,d.products[i])}}
return send(res,404,{error:'Unknown admin action'});
}
if(pathname==='/admin'||pathname==='/admin/')return serve(res,path.join(root,'admin.html'));
const dist=path.join(root,'dist');const requested=path.resolve(dist,'.'+pathname);if(!requested.startsWith(dist+path.sep)&&requested!==dist)return send(res,403,{error:'Forbidden'});
if(fs.existsSync(requested)&&fs.statSync(requested).isFile())return serve(res,requested);
return serve(res,path.join(dist,'index.html'));
}catch(e){return send(res,500,{error:e.message})}finally{if(release)release()}
}).listen(port,()=>console.log(`WEHLIYE STORE: http://localhost:${port} | ADMIN: http://localhost:${port}/admin`));
function valid(p){return p&&typeof p.name==='string'&&p.name.trim().length>1&&p.name.length<150&&typeof p.category==='string'&&['Suits','Blazers','Shirts','Shoes','Trousers','Accessories','Casual'].includes(p.category)&&Number.isFinite(Number(p.price))&&Number(p.price)>0&&Number.isInteger(Number(p.stock))&&Number(p.stock)>=0&&typeof p.image==='string'&&p.image.length<3_000_000&&Array.isArray(p.sizes)&&Array.isArray(p.colors)}
function serve(res,file){if(!fs.existsSync(file))return send(res,404,{error:'Run npm run build first'});res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res)}

