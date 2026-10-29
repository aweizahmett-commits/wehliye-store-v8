import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {HttpError,hash,randomToken,readState,updateState,transaction,expireReservations,placeOrder,changeOrderStatus,validateProduct} from './store.mjs';
import {cookies,cookie,session,createSession,revoke,limit,beginOAuth,consumeOAuth,pruneAuth} from './auth.mjs';
import {equal,securityHeaders,requireOrigin,body,clientAddress} from './security.mjs';

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
export function createApp({pool,root,publicUrl,adminUser,adminPassword,googleClient='',googleSecret='',proxyHops=0,fetchImpl=fetch,logger=console}) {
  const secure=publicUrl.startsWith('https:');
  const send=(res,status,data)=>{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(data));
  };
  const setCookie=(res,name,value,seconds)=>res.setHeader('Set-Cookie',cookie(name,value,seconds,secure));
  const customer=req=>session(pool,cookies(req).ws_customer,'customer');
  const admin=req=>session(pool,cookies(req).ws_admin,'admin');
  async function requireCustomer(req) {
    const c=await customer(req);
    if(!c)throw new HttpError(401,'Google sign in required');
    return c;
  }
  async function requireAdmin(req) {
    const a=await admin(req);
    if(!a || a.username!==adminUser)throw new HttpError(401,'Admin login required');
    return a;
  }
  async function googleFetch(url,options={}) {
    try {
      const r=await fetchImpl(url,{...options,signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!r.ok)throw new HttpError(401,'Google sign-in failed. Please try again.');
      return await r.json();
    } catch(e) {
      if(e instanceof HttpError)throw e;
      throw new HttpError(502,'Google sign-in is temporarily unavailable');
    }
  }
  function serve(res,file) {
    if(!fs.existsSync(file))return send(res,404,{error:'Page unavailable'});
    if(path.extname(file)==='.html') {
      const html=fs.readFileSync(file,'utf8');
      const hashes=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
        .filter(m=>m[1].trim()).map(m=>"'sha256-"+crypto.createHash('sha256').update(m[1]).digest('base64')+"'");
      res.setHeader('Content-Security-Policy',[
        "default-src 'self'","script-src 'self' "+hashes.join(' '),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:","img-src 'self' https: http: data:",
        "connect-src 'self'","frame-ancestors 'none'","base-uri 'none'","form-action 'self'","object-src 'none'"
      ].join('; '));
      res.writeHead(200,{'Content-Type':mime['.html'],'Cache-Control':'no-store'});return res.end(html);
    }
    res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
    const stream=fs.createReadStream(file);
    stream.on('error',()=>res.destroy());stream.pipe(res);
  }
  const server=http.createServer(async(req,res)=>{
    securityHeaders(res,publicUrl);
    try {
      const url=new URL(req.url,'http://localhost');
      const pathname=url.pathname;
      if(['POST','PUT','PATCH','DELETE'].includes(req.method)) requireOrigin(req,publicUrl);
      if(req.method==='GET' && pathname==='/health/ready') {
        try {
          const d=await readState(pool);
          const schema=await pool.query("SELECT to_regclass('public.wehliye_sessions') IS NOT NULL AND to_regclass('public.wehliye_oauth_states') IS NOT NULL AND to_regclass('public.wehliye_rate_limits') IS NOT NULL AS ready");
          if(!d.products.length || !schema.rows[0].ready || !fs.existsSync(path.join(root,'dist','index.html')))
            return send(res,503,{status:'not_ready'});
          return send(res,200,{status:'ready'});
        } catch {return send(res,503,{status:'not_ready'});}
      }
      if(req.method==='GET' && pathname==='/api/store') {
        const d=await readState(pool);return send(res,200,{products:d.products,content:d.content});
      }
      if(req.method==='GET' && pathname==='/api/auth/me') {
        const c=await customer(req);
        return send(res,200,{user:c?{name:c.name,email:c.email,role:'customer'}:null,googleEnabled:!!(googleClient&&googleSecret)});
      }
      if(req.method==='GET' && pathname==='/api/auth/google') {
        if(!googleClient||!googleSecret)throw new HttpError(503,'Google sign-in is not configured');
        await limit(pool,'oauth:'+clientAddress(req,proxyHops),20,600);
        const previous=cookies(req).ws_oauth;
        const previousBrowser=cookies(req).ws_oauth_browser;
        const browser=/^[a-zA-Z0-9_-]{43}$/.test(previousBrowser||'')?previousBrowser:randomToken();
        const {state,verifier}=await beginOAuth(pool,previous,browser);
        const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
        const params=new URLSearchParams({client_id:googleClient,redirect_uri:publicUrl+'/api/auth/google/callback',
          response_type:'code',scope:'openid email profile',state,access_type:'online',prompt:'select_account',
          code_challenge:challenge,code_challenge_method:'S256'});
        res.setHeader('Set-Cookie',[cookie('ws_oauth',state,600,secure),cookie('ws_oauth_browser',browser,600,secure)]);
        res.writeHead(302,{Location:'https://accounts.google.com/o/oauth2/v2/auth?'+params,'Cache-Control':'no-store'});
        return res.end();
      }
      if(req.method==='GET' && pathname==='/api/auth/google/callback') {
        const state=url.searchParams.get('state'), browser=cookies(req).ws_oauth_browser;
        if(!state || !equal(state,cookies(req).ws_oauth))throw new HttpError(400,'Invalid Google login. Please try again.');
        const verifier=await consumeOAuth(pool,state,browser);
        res.setHeader('Set-Cookie',[cookie('ws_oauth','',0,secure),cookie('ws_oauth_browser','',0,secure)]);
        if(url.searchParams.has('error'))throw new HttpError(401,'Google sign-in was cancelled');
        const code=url.searchParams.get('code');
        if(!code || code.length>4096)throw new HttpError(400,'Invalid Google authorization code');
        const tokens=await googleFetch('https://oauth2.googleapis.com/token',{method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({code,client_id:googleClient,client_secret:googleSecret,
            redirect_uri:publicUrl+'/api/auth/google/callback',grant_type:'authorization_code',code_verifier:verifier})});
        if(typeof tokens.access_token!=='string')throw new HttpError(401,'Google sign-in failed');
        const profile=await googleFetch('https://openidconnect.googleapis.com/v1/userinfo',
          {headers:{Authorization:'Bearer '+tokens.access_token}});
        if(typeof profile.sub!=='string'||!profile.sub||profile.sub.length>255||
            typeof profile.email!=='string'||profile.email.length>320||!profile.email.includes('@')||
            profile.email_verified!==true)throw new HttpError(401,'Google email not verified');
        const login=await updateState(pool,async(d,client)=>{
          let c=d.customers.find(v=>v.googleSub===profile.sub);
          const name=typeof profile.name==='string'?profile.name.slice(0,150):profile.email;
          if(!c){c={googleSub:profile.sub,email:profile.email,name,createdAt:new Date().toISOString()};d.customers.push(c);}
          else {c.email=profile.email;c.name=name;}
          return createSession(client,'customer',{googleSub:c.googleSub,email:c.email,name:c.name},cookies(req).ws_customer);
        });
        res.setHeader('Set-Cookie',[cookie('ws_oauth','',0,secure),cookie('ws_oauth_browser','',0,secure),cookie('ws_customer',login.token,login.seconds,secure)]);
        res.writeHead(302,{Location:'/', 'Cache-Control':'no-store'});return res.end();
      }
      if(req.method==='POST' && pathname==='/api/auth/logout') {
        await revoke(pool,cookies(req).ws_customer,'customer');
        setCookie(res,'ws_customer','',0);return send(res,200,{ok:true});
      }
      if(req.method==='GET' && pathname==='/api/orders') {
        const c=await requireCustomer(req);
        const d=await readState(pool);
        return send(res,200,{orders:d.orders.filter(o=>o.googleSub===c.googleSub).map(publicOrder)});
      }
      if(req.method==='POST' && pathname==='/api/orders') {
        const c=await requireCustomer(req);
        await limit(pool,'checkout:'+c.googleSub,30,60);
        const input=await body(req,64000);
        const result=await updateState(pool,d=>placeOrder(d,c,input,req.headers['idempotency-key']));
        return send(res,result.replayed?200:201,{order:publicOrder(result.order)});
      }
      if(req.method==='POST' && pathname==='/api/admin/login') {
        const address=clientAddress(req,proxyHops);
        await limit(pool,'admin-login:'+address,10,900);
        await limit(pool,'admin-login-global',100,900);
        const input=await body(req,4096);
        if(!equal(input.username,adminUser)||!equal(input.password,adminPassword))throw new HttpError(401,'Invalid admin credentials');
        const login=await transaction(pool,c=>createSession(c,'admin',{username:adminUser},cookies(req).ws_admin));
        setCookie(res,'ws_admin',login.token,login.seconds);return send(res,200,{ok:true});
      }
      if(pathname.startsWith('/api/admin/')) {
        await requireAdmin(req);
        if(req.method==='GET'&&pathname==='/api/admin/me')return send(res,200,{ok:true});
        if(req.method==='POST'&&pathname==='/api/admin/logout') {
          await revoke(pool,cookies(req).ws_admin,'admin');setCookie(res,'ws_admin','',0);return send(res,200,{ok:true});
        }
        if(req.method==='GET'&&pathname==='/api/admin/orders')
          return send(res,200,{orders:(await readState(pool)).orders.map(publicOrder)});
        if(req.method==='GET'&&pathname==='/api/admin/customers')
          return send(res,200,{customers:(await readState(pool)).customers});
        const orderMatch=pathname.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)$/);
        if(orderMatch&&req.method==='PATCH') {
          const input=await body(req,4096);
          const order=await updateState(pool,d=>changeOrderStatus(d,orderMatch[1],input.status));
          return send(res,200,{order:publicOrder(order)});
        }
        if(req.method==='PUT'&&pathname==='/api/admin/content') {
          const input=await body(req,64000);
          const content=await updateState(pool,d=>{
            for(const k of Object.keys(d.content))if(typeof input[k]==='string')d.content[k]=input[k].slice(0,500);
            return d.content;
          });
          return send(res,200,content);
        }
        if(req.method==='POST'&&pathname==='/api/admin/products') {
          const product=validateProduct(await body(req));
          const result=await updateState(pool,d=>{
            let id=Date.now();while(d.products.some(p=>p.id===id))id++;
            const created={...product,id};d.products.unshift(created);return created;
          });
          return send(res,201,result);
        }
        const match=pathname.match(/^\/api\/admin\/products\/(\d+)$/);
        if(match&&['DELETE','PUT'].includes(req.method)) {
          const id=Number(match[1]);
          const product=req.method==='PUT'?validateProduct(await body(req)):null;
          const result=await updateState(pool,d=>{
            const i=d.products.findIndex(p=>p.id===id);
            if(i<0)throw new HttpError(404,'Product not found');
            if(req.method==='DELETE') {
              if(d.orders.some(o=>!['Cancelled','Delivered'].includes(o.status)&&o.items.some(item=>item.id===id)))
                throw new HttpError(409,'Product has active orders; resolve them before removal');
              d.products.splice(i,1);return {ok:true};
            }
            d.products[i]={...d.products[i],...product,id};return d.products[i];
          });
          return send(res,200,result);
        }
        throw new HttpError(404,'Unknown admin action');
      }
      if(pathname.startsWith('/api/'))throw new HttpError(404,'Unknown API route');
      if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'Method not allowed');
      if(pathname==='/admin'||pathname==='/admin/')return serve(res,path.join(root,'admin.html'));
      const dist=path.join(root,'dist'),requested=path.resolve(dist,'.'+decodeURIComponent(pathname));
      if(!requested.startsWith(dist+path.sep)&&requested!==dist)throw new HttpError(403,'Forbidden');
      if(fs.existsSync(requested)&&fs.statSync(requested).isFile())return serve(res,requested);
      return serve(res,path.join(dist,'index.html'));
    } catch(e) {
      const status=e instanceof HttpError?e.status:503;
      if(!(e instanceof HttpError))logger.error(JSON.stringify({event:'request_failed',code:/^[A-Z0-9]{5}$/.test(e.code||'')?e.code:'INTERNAL'}));
      if(status===429)res.setHeader('Retry-After','60');
      // Do not keep an unread rejected request body on a reusable connection.
      if(!req.complete){res.setHeader('Connection','close');res.once('finish',()=>req.destroy());}
      return send(res,status,{error:e instanceof HttpError?e.message:'Service temporarily unavailable'});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  server.maxRequestsPerSocket=100;
  return server;
}
function publicOrder(order) {
  const {idempotencyKey,requestHash,...safe}=order;return safe;
}
export async function maintenance(pool) {
  await transaction(pool,async client=>{
    const state=await readState(client,true);
    if(expireReservations(state))
      await client.query('UPDATE public.store_state SET data=$1::jsonb,updated_at=NOW() WHERE id=1',[JSON.stringify(state)]);
  });
  await pruneAuth(pool);
}
