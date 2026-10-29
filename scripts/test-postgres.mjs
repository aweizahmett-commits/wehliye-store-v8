// Own isolated PostgreSQL cluster only. Never reads DATABASE_URL or local DB_* credentials.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';

const bin=process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
const runRoot=path.resolve('.test-postgres','run-'+crypto.randomUUID());
fs.mkdirSync(runRoot,{recursive:true});
const data=path.join(runRoot,'data');
const marker=path.join(runRoot,'isolated-test-cluster.json');
function run(command,args,env=process.env,inherit=false) {
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{env,windowsHide:true,stdio:inherit?'inherit':['ignore','pipe','pipe']});
  let output='';
  if(!inherit){child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);}
  child.on('error',reject);
  child.on('exit',code=>code===0?resolve(output):reject(Error(path.basename(command)+' exited '+code+(inherit?'':': '+output))));
 });
}
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
let started=false;
try {
 await run(exe('initdb'),['-D',data,'-U','wehliye_test','-A','trust','--encoding=UTF8','--no-locale']);
 fs.writeFileSync(marker,JSON.stringify({purpose:'isolated synthetic integration tests',data,port}));
 await run(exe('pg_ctl'),['-D',data,'-l',path.join(runRoot,'server.log'),'-o','-h 127.0.0.1 -p '+port+' -F','-w','start']);
 started=true;
 const admin=new pg.Client({host:'127.0.0.1',port,user:'wehliye_test',database:'postgres'});
 try{await admin.connect();await admin.query('CREATE DATABASE wehliye_security_test');}finally{await admin.end();}
 console.log('Testing against a new isolated PostgreSQL cluster with synthetic data only.');
 await run(process.execPath,['--test','--test-concurrency=1','tests/integration.test.mjs'],{
  ...process.env,TEST_DATABASE_URL:'postgresql://wehliye_test@127.0.0.1:'+port+'/wehliye_security_test',
  TEST_CLUSTER_MARKER:marker
 },true);
} catch(e) {
 console.error(e.message);process.exitCode=1;
} finally {
 if(started){
  try{await run(exe('pg_ctl'),['-D',data,'-m','fast','-w','stop']);console.log('Isolated test PostgreSQL stopped.');}
  catch(e){console.error(e.message);process.exitCode=1;}
 }
 console.log('Test files retained under .test-postgres/ (ignored by Git).');
}
