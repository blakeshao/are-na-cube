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
  if (blockCache.has(id)) {
    console.log(`[arena] block cache hit: ${id}`);
    return blockCache.get(id);
  }
  console.log(`[arena] fetching block: ${id}`);
  const t0 = performance.now();
  const p = (async () => {
    const r = await arenaFetch(`${ARENA}/blocks/${id}`);
    if (!r.ok) throw new Error(`block ${id}: ${r.status}`);
    const j = await r.json();
    console.log(`[arena] fetched block: ${id} — ${(j.connections || []).length} connections in ${Math.round(performance.now() - t0)}ms`);
    return j;
  })();
  blockCache.set(id, p);
  try { return await p; } catch (e) { blockCache.delete(id); throw e; }
}

const channelContentsCache = new Map();
export async function fetchChannelContents(slug, page = 1, per = 100) {
  const key = `${slug}|${page}|${per}`;
  if (channelContentsCache.has(key)) {
    console.log(`[arena] channel cache hit: ${slug} (p${page}/${per})`);
    return channelContentsCache.get(key);
  }
  console.log(`[arena] fetching channel: ${slug} (p${page}/${per})`);
  const t0 = performance.now();
  const p = (async () => {
    const r = await arenaFetch(`${ARENA}/channels/${encodeURIComponent(slug)}/contents?page=${page}&per=${per}&direction=desc`);
    if (!r.ok) throw new Error(`channel ${slug}: ${r.status}`);
    const j = await r.json();
    console.log(`[arena] fetched channel: ${slug} — ${(j.contents || []).length} items in ${Math.round(performance.now() - t0)}ms`);
    return j;
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
      const pick = await pickRandomChannelWithImageBlocks();
      if (!pick) continue;
      const stub = pick.blocks[Math.floor(Math.random() * pick.blocks.length)];
      return await fetchBlock(stub.id);
    } catch (e) {
      // try again
    }
  }
  throw new Error('could not find a random block');
}

// Build a game scenario: pick a starting block, walk `hops` flips through the
// block graph (each step is the immediate next/prev block within a channel's
// listing — what counts as one cube rotation in-game), then use one of the
// final block's channels as the destination. The walked path is itself a
// valid `hops`-flip solution.
//
// The key constraint vs. picking a random block per channel: each hop is an
// *adjacent* item in the channel listing, because that's what a single cube
// flip actually moves you to. Random-block hops can be 50+ flips apart inside
// a long channel.
//
// Returns `{startBlock, destChannel, destBlockIds}` (a Set of image-block IDs
// in the destination channel) or null if a walk can't be completed.
export async function pickGameSetup(hops = 3) {
  // Pick a starting block with channel connections.
  let startBlock = null;
  for (let i = 0; i < 8 && !startBlock; i++) {
    try {
      const pick = await pickRandomChannelWithImageBlocks();
      if (!pick) continue;
      const stub = pick.blocks[Math.floor(Math.random() * pick.blocks.length)];
      const full = await fetchBlock(stub.id);
      if (getConnections(full).length) startBlock = full;
    } catch (e) { /* retry */ }
  }
  if (!startBlock) return null;

  const visited = new Set([startBlock.id]);
  let current = startBlock;
  for (let hop = 0; hop < hops; hop++) {
    const conns = shuffled(getConnections(current).filter(channelLooksSafe));
    let next = null;
    for (const ch of conns) {
      if (next) break;
      try {
        const contents = await fetchChannelContents(ch.slug, 1, 100);
        if (contents['nsfw?']) continue;
        const list = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
        if (list.length < 2) continue;
        // `current` must be on this page for us to know who its neighbors in
        // the listing actually are. If a channel has > 100 blocks and current
        // lives past page 1 we can't determine a 1-flip neighbor, so skip.
        const idx = list.findIndex(b => b.id === current.id);
        if (idx === -1) continue;
        // Try the immediate forward and backward neighbors (random order).
        const dirs = Math.random() < 0.5 ? [1, -1] : [-1, 1];
        for (const dir of dirs) {
          const cand = list[(idx + dir + list.length) % list.length];
          if (!cand || visited.has(cand.id)) continue;
          try {
            const full = await fetchBlock(cand.id);
            if (!getConnections(full).length) continue;
            next = full;
            break;
          } catch (e) { /* try the other direction */ }
        }
      } catch (e) { /* try next channel */ }
    }
    if (!next) return null;
    visited.add(next.id);
    current = next;
  }

  // Use one of the final block's channels as the destination. The walked
  // path's final block is in that channel, so the path resolves the game —
  // but only if that block also appears on the channel's first page (which
  // is what destBlockIds covers), otherwise the win check never fires.
  const destCandidates = shuffled(getConnections(current).filter(channelLooksSafe));
  for (const ch of destCandidates) {
    try {
      const contents = await fetchChannelContents(ch.slug, 1, 100);
      if (contents['nsfw?']) continue;
      const blocks = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
      if (!blocks.length) continue;
      const destBlockIds = new Set(blocks.map(b => b.id));
      if (!destBlockIds.has(current.id)) continue;
      // Skip channels that already include the start block — that would be a
      // 0-flip win.
      if (destBlockIds.has(startBlock.id)) continue;
      return { startBlock, destChannel: ch, destBlockIds };
    } catch (e) { /* try another */ }
  }
  return null;
}

// Pick a random image-rich, safe channel. Returns `{channel, contents, blocks}`
// where `blocks` is the filtered list of image blocks on the chosen page.
// Returns null when nothing usable is found in a single attempt — callers loop.
export async function pickRandomChannelWithImageBlocks() {
  const term = SEED_TERMS[Math.floor(Math.random() * SEED_TERMS.length)];
  const r = await arenaFetch(`${ARENA}/search/channels?q=${encodeURIComponent(term)}&per=30`);
  if (!r.ok) return null;
  const j = await r.json();
  const candidates = (j.channels || []).filter(c =>
    c.length >= 10 && c.status !== 'private' && channelLooksSafe(c)
  );
  if (!candidates.length) return null;
  const channel = candidates[Math.floor(Math.random() * candidates.length)];
  const maxPage = Math.max(1, Math.ceil(channel.length / 50));
  const page = 1 + Math.floor(Math.random() * Math.min(maxPage, 5));
  const contents = await fetchChannelContents(channel.slug, page, 50);
  if (contents['nsfw?']) return null;
  const blocks = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
  if (!blocks.length) return null;
  return { channel, contents, blocks };
}

export function blockImageUrl(block) {
  if (!block || !block.image) return null;
  // For animated formats, prefer the `original` URL — are.na's resized
  // variants are flattened to static images, so using `large` would lose
  // the animation.
  const ct = block.image.content_type;
  if (ct === 'image/gif' || ct === 'image/webp' || ct === 'image/apng') {
    return block.image.original?.url || block.image.large?.url || block.image.display?.url;
  }
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
  console.log(`[arena] pickSafeChannel: ${safe.length} safe of ${connections.length} (${cached.length} cached, ${cold.length} cold) — trying ${ordered.map(c => c.slug).join(', ')}`);
  const tStart = performance.now();
  for (const channel of ordered) {
    try {
      const contents = await fetchChannelContents(channel.slug, 1, 100);
      if (contents['nsfw?']) { console.log(`[arena] skip nsfw: ${channel.slug}`); continue; }
      console.log(`[arena] pickSafeChannel: picked ${channel.slug} in ${Math.round(performance.now() - tStart)}ms`);
      return { channel, contents };
    } catch (e) {
      console.log(`[arena] pickSafeChannel: ${channel.slug} failed — ${e.message}`);
    }
  }
  console.log(`[arena] pickSafeChannel: nothing usable after ${Math.round(performance.now() - tStart)}ms`);
  return null;
}

