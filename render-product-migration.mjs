import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';

const [mode, file, approvedHash] = process.argv.slice(2);
const targetHost = 'dpg-dbhlhpg8v5cc738qc3rg-a.frankfurt-postgres.render.com';
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function validate(data) {
  if (!data || !Array.isArray(data.products) || data.products.length !== 73)
    throw Error('Expected exactly 73 products; stop and review the source.');
  if (new Set(data.products.map(p => p.id)).size !== 73) throw Error('Duplicate product IDs.');
  for (const p of data.products) {
    if (!Number.isSafeInteger(p.id) || typeof p.name !== 'string' || !p.name.trim() ||
        typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price <= 0 ||
        !Number.isInteger(p.stock) || p.stock < 0 || !Array.isArray(p.sizes) ||
        !Array.isArray(p.colors) || typeof p.image !== 'string' ||
        /localhost|^file:/i.test(p.image)) throw Error('Invalid product: ' + p.id);
  }
  if (!data.content || typeof data.content !== 'object' || Array.isArray(data.content))
    throw Error('Missing storefront content.');
}
async function sourceExport() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const config = sourceUrl ? {connectionString: sourceUrl} : {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD
  };
  if (!sourceUrl && (!config.host || !config.port || !config.database || !config.user))
    throw Error('Explicit local source configuration required.');
  const c = new pg.Client({...config, connectionTimeoutMillis: 8000, statement_timeout: 15000});
  try {
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await c.query('SELECT data FROM public.store_state WHERE id=1');
    if (r.rowCount !== 1) throw Error('Expected source store_state row 1.');
    const data = r.rows[0].data;
    validate(data);
    // Full source snapshot is a private rollback backup; never commit it.
    fs.writeFileSync(file, JSON.stringify(data), {flag: 'wx', mode: 0o600});
    await c.query('ROLLBACK');
    console.log(JSON.stringify({backup: file, products: data.products.length,
      orders: data.orders?.length || 0, customers: data.customers?.length || 0,
      sha256: hash(fs.readFileSync(file, 'utf8'))}));
  } finally { await c.end(); }
}
async function destination() {
  const raw = fs.readFileSync(file, 'utf8');
  if (!approvedHash || hash(raw) !== approvedHash) throw Error('Backup SHA-256 missing or mismatched.');
  const data = JSON.parse(raw); validate(data);
  // Product migration only: preserve product IDs and content, exclude customer/order records.
  const payload = {products: data.products, content: data.content, orders: [], customers: []};
  const u = new URL(process.env.MIGRATION_TARGET_URL || '');
  if (u.hostname !== targetHost || decodeURIComponent(u.pathname) !== '/wehliye_store' ||
      !['postgres:', 'postgresql:'].includes(u.protocol))
    throw Error('Destination does not match the inspected Render database.');
  // Explicit TLS verification for the public endpoint; do not allow URL SSL overrides.
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('ssl')) u.searchParams.delete(k);
  const c = new pg.Client({connectionString: u.toString(), ssl: {rejectUnauthorized: true},
    connectionTimeoutMillis: 10000, statement_timeout: 30000});
  let transaction = false;
  try {
    await c.connect();
    await c.query(mode === 'apply' ? 'BEGIN' : 'BEGIN READ ONLY'); transaction = true;
    await c.query("SET LOCAL lock_timeout = '5s'");
    const identity = (await c.query('SELECT current_database() AS name')).rows[0];
    if (identity.name !== 'wehliye_store') throw Error('Unexpected database identity.');
    const exists = (await c.query("SELECT to_regclass('public.store_state') IS NOT NULL AS present")).rows[0].present;
    if (exists) {
      if (mode === 'apply') await c.query('LOCK TABLE public.store_state IN EXCLUSIVE MODE');
      const count = (await c.query('SELECT count(*)::int AS n FROM public.store_state')).rows[0].n;
      if (count !== 0) throw Error('Destination contains store data. Nothing overwritten.');
    }
    if (mode === 'check') {
      await c.query('ROLLBACK'); transaction = false;
      console.log('CHECK PASSED: backup verified; destination empty; no database changes.');
      return;
    }
    await c.query('CREATE TABLE IF NOT EXISTS public.store_state (id INTEGER PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
    await c.query('LOCK TABLE public.store_state IN EXCLUSIVE MODE');
    if ((await c.query('SELECT count(*)::int AS n FROM public.store_state')).rows[0].n !== 0)
      throw Error('Destination changed during preparation.');
    await c.query('INSERT INTO public.store_state (id,data) VALUES (1,$1::jsonb)', [JSON.stringify(payload)]);
    const verified = (await c.query('SELECT data = $1::jsonb AS same FROM public.store_state WHERE id=1', [JSON.stringify(payload)])).rows[0];
    if (!verified?.same) throw Error('Full JSONB comparison failed.');
    await c.query('COMMIT'); transaction = false;
    console.log('COMMITTED: 73 products and storefront content; full JSONB comparison passed.');
  } catch (e) { if (transaction) await c.query('ROLLBACK'); throw e; }
  finally { await c.end(); }
}
try {
  if (!['export','check','apply'].includes(mode) || !file || !file.endsWith('.backup.json'))
    throw Error('Usage: node render-product-migration.mjs export|check|apply PRIVATE.backup.json [SHA256]');
  if (mode === 'export') await sourceExport(); else await destination();
} catch (e) {
  // Avoid exposing connection strings or credentials in error output.
  console.error('Migration stopped:', String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted connection URL]'));
  process.exitCode = 1;
}
