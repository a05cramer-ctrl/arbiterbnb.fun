// GET /api/candidates -> the ten coins the public rule picks right now.
import { computeCandidates } from './_lib/candidates.js';
import { send, CORS, shortErr } from './_lib/util.js';

let memo = null; // warm-lambda memo so a CDN miss storm doesn't rescan the chain

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v); res.statusCode = 204; return res.end(); }
  try {
    if (!memo || Date.now() - memo.t > 30_000) {
      const r = await computeCandidates({ withMeta: true });
      memo = { t: Date.now(), body: {
        at: r.at, rule: r.rule, window: r.window, from: r.from, to: r.to, blocks: r.blocks,
        list: r.list, scan: r.scan, errors: r.errors,
      } };
    }
    send(res, 200, memo.body, { ...CORS, 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' });
  } catch (e) {
    send(res, 502, { error: shortErr(e), rule: undefined, list: [] }, { ...CORS, 'Cache-Control': 's-maxage=10' });
  }
}
