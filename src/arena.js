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
// Block stubs returned inside a channel's `contents` array usually carry
// their own `connections` list — when they do we can use them directly and
// skip a per-block GET. Falls back to a full `/blocks/:id` fetch only when
// the stub came back stripped (some are.na responses do).
async function blockWithConnections(stub) {
  if (stub && stub.connections && stub.connections.length) return stub;
  return await fetchBlock(stub.id);
}

export async function pickGameSetup(hops = 3) {
  // Pick a starting block with channel connections. To minimise requests we
  // reuse each random channel's listing for several stub attempts — paying
  // for a fresh search + channel fetch only after exhausting a few blocks.
  let startBlock = null;
  outer: for (let i = 0; i < 4 && !startBlock; i++) {
    let pick = null;
    try { pick = await pickRandomChannelWithImageBlocks(); } catch (e) {}
    if (!pick) continue;
    const stubs = pick.blocks.slice(0, Math.min(4, pick.blocks.length));
    for (const stub of stubs) {
      try {
        const full = await blockWithConnections(stub);
        if (getConnections(full).length) { startBlock = full; break outer; }
      } catch (e) { /* try next stub from the same page */ }
    }
  }
  if (!startBlock) return null;

  // At each hop we have at most two solver-friendly strategies, both aligned
  // with what the game's axis-picker will surface to the user:
  //   - "continue": stay on the previous channel in the same direction —
  //     equivalent to one more flip on the same cube axis.
  //   - "switch": jump to the top safe channel *excluding* the previous one
  //     with a random direction — equivalent to flipping the perpendicular
  //     axis, which the game freshly picks as the top non-kept channel.
  // Strategy order is randomized per hop so we get a mix of same-axis runs
  // and axis switches, instead of always sliding in one direction.
  const visited = new Set([startBlock.id]);
  // `walkedPath` is the constructed 1-flip-per-step solution. Returned to the
  // caller so the game can report a deterministic "N flips away" stat: at the
  // start the user is on path[0] so distance = hops; each correct flip drops
  // it by one. Without this the runtime scan can report <hops (shortcut found
  // in visible channels) or "many" (destination simply not in view).
  const walkedPath = [startBlock.id];
  let current = startBlock;
  let keptChannel = null;
  let keptDirection = null; // +1 or -1; defined once keptChannel is set
  for (let hop = 0; hop < hops; hop++) {
    const allConns = getConnections(current).filter(channelLooksSafe);
    const switchChannel = allConns.find(c => c.slug !== keptChannel?.slug) || null;
    const continueChannel = keptChannel && allConns.some(c => c.slug === keptChannel.slug)
      ? keptChannel : null;

    // Prefer "switch" so the path alternates cube axes (and thus visual
    // directions) instead of marching in a single one. "continue" reuses
    // keptDirection by construction, so a chain of continues looks like a
    // single slide in one direction. We only fall through to it when the
    // switch channel can't produce an unvisited neighbor.
    const strategies = [];
    if (switchChannel) {
      strategies.push({
        channel: switchChannel,
        dirs: Math.random() < 0.5 ? [1, -1] : [-1, 1],
      });
    }
    if (continueChannel) {
      strategies.push({ channel: continueChannel, dirs: [keptDirection] });
    }

    let next = null;
    let chosenChannel = null;
    let chosenDir = null;
    for (const strat of strategies) {
      if (next) break;
      try {
        const contents = await fetchChannelContents(strat.channel.slug, 1, 100);
        if (contents['nsfw?']) continue;
        const list = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
        if (list.length < 2) continue;
        // `current` must be on this page for us to know who its neighbors in
        // the listing actually are. If a channel has > 100 blocks and current
        // lives past page 1 we can't determine a 1-flip neighbor, so skip.
        const idx = list.findIndex(b => b.id === current.id);
        if (idx === -1) continue;
        for (const dir of strat.dirs) {
          const cand = list[(idx + dir + list.length) % list.length];
          if (!cand || visited.has(cand.id)) continue;
          try {
            const full = await blockWithConnections(cand);
            if (!getConnections(full).length) continue;
            next = full;
            chosenChannel = strat.channel;
            chosenDir = dir;
            break;
          } catch (e) { /* try the other direction */ }
        }
      } catch (e) { /* try next strategy */ }
    }
    if (!next) return null;
    visited.add(next.id);
    walkedPath.push(next.id);
    current = next;
    keptChannel = chosenChannel;
    keptDirection = chosenDir;
  }

  // Use one of the final block's channels as the destination. The walked
  // path's final block is in that channel, so the path resolves the game —
  // but only if that block also appears on the channel's first page (which
  // is what destBlockIds covers), otherwise the win check never fires.
  //
  // `keptChannel` is the channel the final hop traveled through; we fetched
  // it during the walk so it's still in cache. Try it first — if it works
  // the destination costs zero extra requests.
  const safeConns = getConnections(current).filter(channelLooksSafe);
  const destCandidates = keptChannel
    ? [
        ...safeConns.filter(c => c.slug === keptChannel.slug),
        ...safeConns.filter(c => c.slug !== keptChannel.slug),
      ]
    : safeConns;
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
      return { startBlock, destChannel: ch, destBlockIds, walkedPath };
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
//
// Browse mode shuffles (cached-first for speed, random within each tier) so
// every visit feels fresh. Game mode passes `deterministic: true` to walk
// the block's natural connection order — `pickGameSetup` builds the solution
// path against that same rule, so the constructed path is the one the user
// actually sees on the cube.
export async function pickSafeChannelWithContents(connections, excludeSlugs = [], { deterministic = false } = {}) {
  const exclude = new Set(excludeSlugs);
  const safe = connections.filter(c => channelLooksSafe(c) && !exclude.has(c.slug));
  let ordered;
  if (deterministic) {
    ordered = safe;
  } else {
    const cached = shuffled(safe.filter(c => hasCachedContents(c.slug)));
    const cold = shuffled(safe.filter(c => !hasCachedContents(c.slug)));
    ordered = [...cached, ...cold];
  }
  console.log(`[arena] pickSafeChannel: ${ordered.length} safe of ${connections.length} (${deterministic ? 'deterministic' : 'shuffled'}) — trying ${ordered.map(c => c.slug).join(', ')}`);
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

