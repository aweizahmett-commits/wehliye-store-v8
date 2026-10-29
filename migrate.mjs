import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

const db = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

try {
  const data = JSON.parse(
    fs.readFileSync('./store-data.json', 'utf8')
  );

  await db.connect();

  const existing = await db.query(
    'SELECT id FROM store_state WHERE id = 1'
  );

  if (existing.rowCount > 0) {
    console.log('Database already contains store data. Nothing overwritten.');
  } else {
    await db.query(
      'INSERT INTO store_state (id, data) VALUES ($1, $2::jsonb)',
      [1, JSON.stringify(data)]
    );

    console.log('SUCCESS: WEHLIYE STORE data migrated to PostgreSQL!');
    console.log('Products:', data.products?.length ?? 0);
    console.log('Orders:', data.orders?.length ?? 0);
    console.log('Customers:', data.customers?.length ?? 0);
  }
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}