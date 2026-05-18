const ARENA = import.meta.env.DEV ? '/arena' : 'https://api.are.na/v2';

// Are.na rate-limits aggressively (~60 req/min). Wrap fetch so 429s back off
// instead of bubbling up and aborting the random-block search.
let rateLimitedUntil = 0;
async function arenaFetch(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = rateLimitedUntil - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const r = await fetch(url);
    if (r.status !== 429) return r;
    const retryAfter = parseFloat(r.headers.get('retry-after') || '');
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(8000, 500 * 2 ** attempt);
    rateLimitedUntil = Date.now() + backoff;
  }
  return fetch(url);
}

const blockCache = new Map();
export async function fetchBlock(id) {
  if (blockCache.has(id)) return blockCache.get(id);
  const p = (async () => {
    const r = await arenaFetch(`${ARENA}/blocks/${id}`);
    if (!r.ok) throw new Error(`block ${id}: ${r.status}`);
    return r.json();
  })();
  blockCache.set(id, p);
  try { return await p; } catch (e) { blockCache.delete(id); throw e; }
}

const channelContentsCache = new Map();
export async function fetchChannelContents(slug, page = 1, per = 100) {
  const key = `${slug}|${page}|${per}`;
  if (channelContentsCache.has(key)) return channelContentsCache.get(key);
  const p = (async () => {
    const r = await arenaFetch(`${ARENA}/channels/${encodeURIComponent(slug)}/contents?page=${page}&per=${per}&direction=desc`);
    if (!r.ok) throw new Error(`channel ${slug}: ${r.status}`);
    return r.json();
  })();
  channelContentsCache.set(key, p);
  try { return await p; } catch (e) { channelContentsCache.delete(key); throw e; }
}

function hasCachedContents(slug, page = 1, per = 100) {
  return channelContentsCache.has(`${slug}|${page}|${per}`);
}

function shuffled(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function parseBlockInput(s) {
  s = (s || '').trim();
  const m = s.match(/are\.na\/block\/(\d+)/i) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

// Recognise a channel URL like https://www.are.na/<user>/<channel-slug>.
// Returns the slug or null. We intentionally exclude /block/, /search/ etc.
export function parseChannelInput(s) {
  s = (s || '').trim();
  const m = s.match(/are\.na\/([^/\s?#]+)\/([^/\s?#]+)/i);
  if (!m) return null;
  const reserved = new Set(['block', 'search', 'explore', 'channels', 'blocks']);
  if (reserved.has(m[1].toLowerCase())) return null;
  return m[2];
}

// NSFW filtering. Are.na exposes a self-reported `nsfw?` boolean on channel
// objects (returned by /search/channels and /channels/:slug) — but it is
// absent from the truncated channel summaries inside a block's `connections`
// array. We combine the flag with a title-keyword backstop for unmarked
// channels.
const NSFW_KEYWORDS = [
  'nsfw', 'nude', 'porn', 'erotic', 'sex', 'naked', 'fetish',
  'kink', 'xxx', 'explicit', 'adult', '18+', 'lewd', 'hentai',
];
function titleLooksNsfw(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return NSFW_KEYWORDS.some(w => t.includes(w));
}
function channelLooksSafe(c) {
  if (!c) return false;
  if (c['nsfw?']) return false;
  if (titleLooksNsfw(c.title)) return false;
  return true;
}

// Seed terms used to find interesting channels via search. Picked to bias
// toward image-heavy, well-curated areas of Are.na rather than the recent
// channels feed (which is dominated by SEO spam).
const SEED_TERMS = [
  'image', 'photo', 'collage', 'texture', 'pattern',
  'poster', 'archive', 'painting', 'sculpture', 'sky',
  'interior', 'graphic', 'color', 'landscape', 'object',
  'still life', 'matter', 'surface', 'plant', 'light',
];

export async function pickRandomBlock() {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const term = SEED_TERMS[Math.floor(Math.random() * SEED_TERMS.length)];
      const r = await arenaFetch(`${ARENA}/search/channels?q=${encodeURIComponent(term)}&per=30`);
      if (!r.ok) continue;
      const j = await r.json();
      const candidates = (j.channels || []).filter(c =>
        c.length >= 10 && c.status !== 'private' && channelLooksSafe(c)
      );
      if (!candidates.length) continue;
      const channel = candidates[Math.floor(Math.random() * candidates.length)];
      const maxPage = Math.max(1, Math.ceil(channel.length / 50));
      const page = 1 + Math.floor(Math.random() * Math.min(maxPage, 5));
      const contents = await fetchChannelContents(channel.slug, page, 50);
      const blocks = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
      if (!blocks.length) continue;
      const stub = blocks[Math.floor(Math.random() * blocks.length)];
      return await fetchBlock(stub.id);
    } catch (e) {
      // try again
    }
  }
  throw new Error('could not find a random block');
}

export function blockImageUrl(block) {
  if (!block || !block.image) return null;
  return block.image.large?.url || block.image.display?.url || block.image.original?.url;
}

export function getConnections(block) {
  return (block.connections || []).filter(c => c && c.slug && c.status !== 'private');
}

// Pick one safe channel and return it together with its contents. The NSFW
// check piggybacks on the contents fetch (the envelope carries `nsfw?`), so
// we don't pay a separate meta GET per candidate. On an NSFW hit we discard
// and try another candidate.
export async function pickSafeChannelWithContents(connections, excludeSlugs = []) {
  const exclude = new Set(excludeSlugs);
  const safe = connections.filter(c => channelLooksSafe(c) && !exclude.has(c.slug));
  // Prefer already-prefetched channels (instant) over cold ones (network).
  // Within each tier, pick randomly to preserve variety.
  const cached = shuffled(safe.filter(c => hasCachedContents(c.slug)));
  const cold = shuffled(safe.filter(c => !hasCachedContents(c.slug)));
  const ordered = [...cached, ...cold];
  for (const channel of ordered) {
    try {
      const contents = await fetchChannelContents(channel.slug, 1, 100);
      if (contents['nsfw?']) continue;
      return { channel, contents };
    } catch (e) {
      // try another
    }
  }
  return null;
}

