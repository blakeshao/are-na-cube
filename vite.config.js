import { Buffer } from 'node:buffer';

const ARENA_BASE = 'https://api.are.na/v2';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const NEGATIVE_TTL_MS = 30 * 1000;   // brief cache for 404s so we don't re-hammer

function arenaCachePlugin() {
  const cache = new Map(); // url -> { expires, status, headers, body }
  return {
    name: 'arena-cache',
    configureServer(server) {
      server.middlewares.use('/arena', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const target = ARENA_BASE + req.url;
        const now = Date.now();
        const cached = cache.get(target);
        if (cached && cached.expires > now) {
          serve(res, cached.status, cached.headers, cached.body, 'HIT');
          return;
        }
        try {
          const r = await fetch(target);
          const buf = Buffer.from(await r.arrayBuffer());
          const headers = {};
          for (const [k, v] of r.headers.entries()) {
            // fetch decompresses; drop encoding/length headers so they don't lie.
            if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') continue;
            headers[k] = v;
          }
          if (r.ok) {
            cache.set(target, { expires: now + CACHE_TTL_MS, status: r.status, headers, body: buf });
          } else if (r.status === 404) {
            cache.set(target, { expires: now + NEGATIVE_TTL_MS, status: r.status, headers, body: buf });
          }
          serve(res, r.status, headers, buf, 'MISS');
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'arena fetch failed', message: String(e.message || e) }));
        }
      });
    },
  };
}

function serve(res, status, headers, body, cacheState) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('x-arena-cache', cacheState);
  res.end(body);
}

export default {
  plugins: [arenaCachePlugin()],
  server: { port: 5173, open: false },
};
