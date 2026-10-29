import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import {databaseConfig} from './deployment-config.mjs';
import {transaction} from './backend/store.mjs';

const mode=process.argv[2];
if(!['--check','--apply'].includes(mode)) {
  console.error('Usage: node migrate-auth.mjs --check | --apply (apply requires explicit database-change approval)');
  process.exitCode=1;
} else {
  const pool=new pg.Pool(databaseConfig());
  try {
    if(mode==='--check') {
      const r=await pool.query("SELECT to_regclass('public.wehliye_sessions') IS NOT NULL AS sessions,to_regclass('public.wehliye_oauth_states') IS NOT NULL AS oauth_states,to_regclass('public.wehliye_rate_limits') IS NOT NULL AS rate_limits");
      console.log(JSON.stringify(r.rows[0]));
    } else {
      await transaction(pool,async client=>{
        await client.query("SELECT pg_advisory_xact_lock(87124118)");
        await client.query(fs.readFileSync(new URL('./migrations/001-auth.sql',import.meta.url),'utf8'));
      });
      console.log('Authentication tables prepared; product/store data was not modified.');
    }
  } catch {
    console.error('Authentication schema operation failed. No credentials are logged.');
    process.exitCode=1;
  } finally{await pool.end();}
}
