// Small shared helpers. No dependencies beyond ethers.
import { formatEther } from 'ethers';

/** Run async fns with at most `n` in flight. Returns results in input order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Await a promise, return `fallback` on any error (and record it in `errors` if given). */
export async function safe(p, fallback = null, errors = null, label = '') {
  try { return await (typeof p === 'function' ? p() : p); }
  catch (e) { if (errors) errors.push(`${label}: ${shortErr(e)}`); return fallback; }
}

export function shortErr(e) {
  if (!e) return 'error';
  if (e.revert?.name) return `${e.revert.name}(${(e.revert.args || []).map(String).join(',')})`;
  return String(e.shortMessage || e.reason || e.message || e).slice(0, 240);
}

/** Display-only token strings: strip control/bidi/zero-width chars, collapse spaces, cap length. */
export function sanitize(s, max = 24) {
  if (typeof s !== 'string') return null;
  const clean = s
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(clean);
  return cps.length > max ? cps.slice(0, max).join('') : clean;
}

export const bnb = v => (v == null ? null : formatEther(v));
export const num = v => (v == null ? null : Number(v));
export const str = v => (v == null ? null : v.toString());

export function envInt(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// ---- tiny Vercel-handler helpers (work with plain Node req/res too)

export function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch { return {}; }
}

export function send(res, code, body, headers = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = code;
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
