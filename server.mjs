import 'dotenv/config';
import pg from 'pg';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {databaseConfig,validateProduction} from './deployment-config.mjs';
import {createApp,maintenance} from './backend/app.mjs';

let pool;
try {
  validateProduction();
  const adminPassword=process.env.ADMIN_PASSWORD;
  if(!adminPassword||adminPassword.length<12)throw Error('ADMIN_PASSWORD must have 12+ characters');
  const port=Number(process.env.PORT||3001);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT');
  const proxyHops=Number(process.env.TRUST_PROXY_HOPS||0);
  if(!Number.isInteger(proxyHops)||proxyHops<0||proxyHops>5)throw Error('Invalid TRUST_PROXY_HOPS');
  pool=new pg.Pool(databaseConfig());
  pool.on('error',()=>console.error('PostgreSQL pool connection error'));
  const server=createApp({pool,root:path.dirname(fileURLToPath(import.meta.url)),
    publicUrl:process.env.PUBLIC_URL||'http://localhost:'+port,
    adminUser:process.env.ADMIN_USER||'owner',adminPassword,
    googleClient:process.env.GOOGLE_CLIENT_ID,googleSecret:process.env.GOOGLE_CLIENT_SECRET,proxyHops});
  let maintaining=false,stopping=false;
  const timer=setInterval(async()=>{
    if(maintaining||stopping)return;
    maintaining=true;
    try{await maintenance(pool);}catch{console.error('Scheduled store maintenance failed');}
    finally{maintaining=false;}
  },60000);
  timer.unref();
  server.listen(port,'0.0.0.0',()=>console.log('WEHLIYE STORE listening on port '+port));
  server.on('error',()=>{console.error('HTTP server failed');shutdown(1);});
  function shutdown(exitCode=0) {
    if(stopping)return;stopping=true;clearInterval(timer);
    const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();
    server.close(async()=>{
      try{await pool.end();clearTimeout(deadline);process.exit(exitCode);}
      catch{process.exit(1);}
    });
  }
  process.on('SIGTERM',()=>shutdown());
  process.on('SIGINT',()=>shutdown());
} catch {
  console.error('Startup configuration invalid. Check required environment variables; no secret values are logged.');
  if(pool)await pool.end();
  process.exitCode=1;
}
