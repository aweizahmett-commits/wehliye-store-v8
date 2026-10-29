import {hash,randomToken,HttpError,transaction} from './store.mjs';

const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;
export function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0,index).trim();
    try { result[key] = decodeURIComponent(part.slice(index+1).trim()); } catch {}
  }
  return result;
}
export function cookie(name,value,maxAge,secure) {
  return name+'='+encodeURIComponent(value)+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+maxAge+(secure?'; Secure':'');
}
export async function createSession(client,kind,profile,previousToken) {
  const token = randomToken();
  if (previousToken && tokenPattern.test(previousToken)) {
    await client.query('DELETE FROM public.wehliye_sessions WHERE token_hash=$1 AND kind=$2',[hash(previousToken),kind]);
  }
  const seconds = kind === 'admin' ? 8*3600 : 7*86400;
  await client.query("INSERT INTO public.wehliye_sessions(token_hash,kind,profile,expires_at) VALUES($1,$2,$3::jsonb,NOW()+$4*INTERVAL '1 second')",
    [hash(token),kind,JSON.stringify(profile),seconds]);
  return {token,seconds};
}
export async function session(pool,token,kind) {
  if (!token || !tokenPattern.test(token)) return null;
  const r = await pool.query('SELECT profile FROM public.wehliye_sessions WHERE token_hash=$1 AND kind=$2 AND expires_at>NOW()',[hash(token),kind]);
  return r.rows[0]?.profile || null;
}
export async function revoke(pool,token,kind) {
  if (token && tokenPattern.test(token))
    await pool.query('DELETE FROM public.wehliye_sessions WHERE token_hash=$1 AND kind=$2',[hash(token),kind]);
}
export async function limit(pool,key,max,seconds) {
  const r = await pool.query(`INSERT INTO public.wehliye_rate_limits(key_hash,attempts,expires_at)
    VALUES($1,1,NOW()+$2*INTERVAL '1 second')
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN wehliye_rate_limits.expires_at<=NOW() THEN 1 ELSE wehliye_rate_limits.attempts+1 END,
      expires_at=CASE WHEN wehliye_rate_limits.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE wehliye_rate_limits.expires_at END
    RETURNING attempts`,[hash(key),seconds]);
  if (r.rows[0].attempts > max) throw new HttpError(429,'Too many requests. Please try again later.');
}
export async function beginOAuth(pool,previousState,browser) {
  const state=randomToken(), verifier=randomToken();
  await transaction(pool,async client => {
    if (previousState && tokenPattern.test(previousState))
      await client.query('DELETE FROM public.wehliye_oauth_states WHERE state_hash=$1 AND browser_hash=$2',[hash(previousState),hash(browser)]);
    await client.query("INSERT INTO public.wehliye_oauth_states(state_hash,browser_hash,verifier,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')",
      [hash(state),hash(browser),verifier]);
  });
  return {state,verifier};
}
export async function consumeOAuth(pool,state,browser) {
  if (!state || !browser || !tokenPattern.test(state) || !tokenPattern.test(browser))
    throw new HttpError(400,'Invalid or expired Google login. Please try again.');
  const r = await pool.query('DELETE FROM public.wehliye_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>NOW() RETURNING verifier',
    [hash(state),hash(browser)]);
  if (!r.rowCount) throw new HttpError(400,'Invalid or expired Google login. Please try again.');
  return r.rows[0].verifier;
}
export async function pruneAuth(pool) {
  await pool.query('DELETE FROM public.wehliye_sessions WHERE expires_at<=NOW()');
  await pool.query('DELETE FROM public.wehliye_oauth_states WHERE expires_at<=NOW()');
  await pool.query('DELETE FROM public.wehliye_rate_limits WHERE expires_at<=NOW()');
}
