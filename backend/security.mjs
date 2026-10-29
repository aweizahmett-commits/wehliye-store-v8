import crypto from 'node:crypto';
import {HttpError} from './store.mjs';

export function equal(a,b) {
  const digest = value => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return crypto.timingSafeEqual(digest(a),digest(b));
}
export function securityHeaders(res,publicUrl) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if (publicUrl.startsWith('https:')) res.setHeader('Strict-Transport-Security','max-age=31536000');
}
export function requireOrigin(req,publicUrl) {
  if (req.headers.origin !== new URL(publicUrl).origin ||
      (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])))
    throw new HttpError(403,'A same-origin request is required');
}
export async function body(req,max=5000000) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw new HttpError(415,'Content-Type must be application/json');
  if (Number(req.headers['content-length']) > max) throw new HttpError(413,'Request too large');
  const chunks=[];let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>max) throw new HttpError(413,'Request too large');
    chunks.push(chunk);
  }
  try {
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data!=='object' || Array.isArray(data)) throw Error();
    return data;
  } catch { throw new HttpError(400,'Invalid JSON body'); }
}
export function clientAddress(req,proxyHops=0) {
  // Forwarded headers are ignored unless deployment explicitly declares a trusted proxy count.
  const peer=req.socket.remoteAddress || 'unknown';
  if (!proxyHops) return peer;
  const chain=(req.headers['x-forwarded-for'] || '').split(',').map(v=>v.trim()).filter(Boolean);
  return [...chain,peer].at(-1-proxyHops) || peer;
}
