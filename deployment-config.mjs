import 'dotenv/config';

export function databaseConfig(env = process.env) {
  const common = {connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000,
    max: 5, statement_timeout: 15000};
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw Error('Invalid DATABASE_URL protocol');
    const externalRender = url.hostname.endsWith('-postgres.render.com');
    if (externalRender) {
      for (const key of [...url.searchParams.keys()]) {
        if (key.startsWith('ssl')) url.searchParams.delete(key);
      }
    }
    return {...common, connectionString: url.toString(),
      ...(externalRender ? {ssl: {rejectUnauthorized: true}} : {})};
  }
  if (env.NODE_ENV === 'production') throw Error('DATABASE_URL is required in production');
  for (const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD']) {
    if (!env[key]) throw Error(key + ' is required for local PostgreSQL');
  }
  const port = Number(env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid DB_PORT');
  return {...common, host: env.DB_HOST, port, database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD};
}

export function validateProduction(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (!env.ADMIN_USER?.trim()) throw Error('ADMIN_USER is required in production');
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) throw Error('ADMIN_PASSWORD must have 12+ characters');
  const url = new URL(env.PUBLIC_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || env.PUBLIC_URL.endsWith('/')) {
    throw Error('PUBLIC_URL must be an HTTPS origin without a trailing slash');
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw Error('Google OAuth credentials are required in production');
}
