import {
  fetchBlock,
  parseBlockInput,
  parseChannelInput,
  pickRandomBlock,
  fetchChannelContents,
  getConnections,
  pickSafeChannelWithContents,
  pickRandomChannelWithImageBlocks,
  pickGameSetup,
} from './arena.js';
import { paintFace } from './rendering.js';
import { createScene, FACES, HALF_PI } from './cube3d.js';

const canvas = document.getElementById('stage');
const { renderer, scene, camera, cube, faceTextures, resize: resizeScene } = createScene(canvas);

// ---------- layout ----------
// On small screens the UI closes in on the cube from above and below (see the
// matching media queries in styles.css), so the cube is fitted to the gap
// that's left instead of the whole viewport.
const stackedLayout = window.matchMedia('(orientation: portrait) and (max-width: 820px)');
const shortLandscape = window.matchMedia('(orientation: landscape) and (max-height: 520px)');
function layoutCube() {
  const bottomOf = (id) => document.getElementById(id).getBoundingClientRect().bottom;
  let insets;
  if (stackedLayout.matches) {
    insets = {
      top: Math.max(bottomOf('entry'), bottomOf('game-panel')),
      bottom: window.innerHeight - document.getElementById('controls-hint').getBoundingClientRect().top,
    };
  } else if (shortLandscape.matches) {
    insets = { top: bottomOf('entry'), bottom: 0 };
  }
  resizeScene(insets);
}
window.addEventListener('resize', layoutCube);
layoutCube();

// ---------- cube state ----------
const cubeState = {
  current: null,
  channelH: null,
  channelV: null,
  blocksH: [],
  blocksV: [],
  idxH: 0,
  idxV: 0,
  faces: { front: null, right: null, left: null, top: null, bottom: null, back: null },
  // True while an async lookup is in flight for that slot. Used by updateMeta
  // to distinguish "we're still loading" (skeleton) from "we tried and gave
  // up" (em-dash / empty).
  loadingCurrent: true,
  loadingH: true,
  loadingV: true,
};

function paint(faceName, block) {
  return paintFace(faceTextures, faceName, block);
}

function blockAt(blocks, idx) {
  if (!blocks.length) return null;
  const n = blocks.length;
  return blocks[((idx % n) + n) % n];
}

// Each cube axis is a channel plus a position in that channel's listing.
const AXIS_KEYS = {
  H: { channel: 'channelH', blocks: 'blocksH', idx: 'idxH', loading: 'loadingH' },
  V: { channel: 'channelV', blocks: 'blocksV', idx: 'idxV', loading: 'loadingV' },
};

function setAxis(axis, { channel, blocks, idx }) {
  const k = AXIS_KEYS[axis];
  cubeState[k.channel] = channel;
  cubeState[k.blocks] = blocks;
  cubeState[k.idx] = idx;
}

// Build an axis from a channel listing, positioned on `block`.
//
// We only fetch the first page of a channel, so `block` is often missing from
// the listing (long channels, or a block connected further back). It still
// needs a real slot: without one it squats on index 0, and flipping away and
// back lands on whatever block actually lives there — the user can't return
// to where they just were. Putting it at the head keeps every flip reversible.
function axisFromContents(channel, contents, block) {
  const blocks = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
  let idx = blocks.findIndex(b => b.id === block.id);
  if (idx === -1) {
    blocks.unshift(block);
    idx = 0;
  }
  return { channel, blocks, idx };
}

// Everything that defines "where the user is". The block lists are never
// mutated after an axis is built, so captured states can share them.
function captureState() {
  const { current, channelH, channelV, blocksH, blocksV, idxH, idxV } = cubeState;
  return { current, channelH, channelV, blocksH, blocksV, idxH, idxV };
}

function restoreState(s) {
  Object.assign(cubeState, s, { loadingCurrent: false, loadingH: false, loadingV: false });
}

// Bumped by every seed. Async navigation work captures it and bails if a newer
// seed has taken over the cube in the meantime.
let navEpoch = 0;

function populateNeighbors() {
  const { blocksH, blocksV, idxH, idxV, current } = cubeState;
  cubeState.faces.right = blockAt(blocksH, idxH + 1);
  cubeState.faces.left = blockAt(blocksH, idxH - 1);
  cubeState.faces.top = blockAt(blocksV, idxV - 1);
  cubeState.faces.bottom = blockAt(blocksV, idxV + 1);
  cubeState.faces.back = blockAt(blocksH, idxH + 2) || current;
  for (const f of ['right', 'left', 'top', 'bottom', 'back']) {
    paint(f, cubeState.faces[f]);
  }
  if (gameState.active) renderGamePanel();
}

async function seed(block) {
  const tSeed = performance.now();
  console.log(`[seed] start block=${block.id}`);
  const epoch = ++navEpoch;
  // Hold off flips until both axes exist — a flip onto a face that hasn't
  // loaded yet has nowhere to go.
  promoting = true;
  queuedTurn = null;
  state.targetX = state.targetY = 0;
  cubeState.blocksH = [];
  cubeState.blocksV = [];
  cubeState.idxH = cubeState.idxV = 0;
  cubeState.current = block;
  cubeState.loadingCurrent = false;
  if (gameState.active && block?.id) gameState.visitedBlocks.add(block.id);
  checkWin();
  cubeState.channelH = null;
  cubeState.channelV = null;
  cubeState.loadingH = true;
  cubeState.loadingV = true;
  cubeState.faces.front = block;
  cubeState.faces.back = block;
  paint('front', block);
  paint('back', block);
  for (const f of ['right', 'left', 'top', 'bottom']) {
    cubeState.faces[f] = null;
    paint(f, null);
  }
  updateMeta();

  try {
    const connections = getConnections(block);
    console.log(`[seed] ${connections.length} connections`);
    if (!connections.length) return;
    const opts = { deterministic: gameState.active };
    const hPick = await pickSafeChannelWithContents(connections, [], opts);
    if (epoch !== navEpoch || !hPick) return;
    cubeState.channelH = hPick.channel;
    cubeState.loadingH = false;
    const vPick = await pickSafeChannelWithContents(connections, [hPick.channel.slug], opts) || hPick;
    if (epoch !== navEpoch) return;

    setAxis('H', axisFromContents(hPick.channel, hPick.contents, block));
    setAxis('V', axisFromContents(vPick.channel, vPick.contents, block));
    populateNeighbors();
  } finally {
    // A newer seed owns the cube (and these flags) if the epoch moved on.
    if (epoch === navEpoch) {
      cubeState.loadingH = false;
      cubeState.loadingV = false;
      promoting = false;
      wheelLocked = false;
      updateMeta();
    }
    console.log(`[seed] done in ${Math.round(performance.now() - tSeed)}ms — loadingCurrent=${cubeState.loadingCurrent} loadingH=${cubeState.loadingH} loadingV=${cubeState.loadingV}`);
  }
}

// Face permutations after a 90° single-axis rotation. Each entry maps a NEW
// face position to the OLD face whose block now occupies it. So new.front =
// faces[p.front] means "the block previously on p.front is now in front."
const PERMUTE = {
  'y-1': { front: 'right', right: 'back',  back: 'left',  left: 'front', top: 'top',    bottom: 'bottom' },
  'y+1': { front: 'left',  left: 'back',   back: 'right', right: 'front', top: 'top',   bottom: 'bottom' },
  'x+1': { front: 'top',   top: 'back',    back: 'bottom', bottom: 'front', left: 'left', right: 'right' },
  'x-1': { front: 'bottom', bottom: 'back', back: 'top',   top: 'front',  left: 'left', right: 'right' },
};

// A flip is one quarter turn on one axis, which moves one step along that
// axis's channel: `dir` +1 is the next block in the listing (right / down),
// -1 the previous (left / up). `face` is the neighbor that comes to the front.
const FLIPS = {
  H: { 1: { face: 'right', perm: 'y-1' }, [-1]: { face: 'left', perm: 'y+1' } },
  V: { 1: { face: 'bottom', perm: 'x-1' }, [-1]: { face: 'top', perm: 'x+1' } },
};

function applyPermutation(key) {
  const p = PERMUTE[key];
  const old = { ...cubeState.faces };
  const next = {};
  for (const f of FACES) next[f] = old[p[f]];
  cubeState.faces = next;
  for (const f of FACES) paint(f, next[f]);
}

// ---------- game mode ----------
const gameState = {
  active: false,
  destChannel: null,
  destBlockIds: new Set(),
  // The constructed solution path (array of block IDs from start → destination).
  // When the user is sitting on one of these blocks, distance is exact:
  // `path.length - 1 - index`. Off-path positions fall back to the scan
  // heuristic, which is best-effort.
  path: [],
  steps: 0,
  won: false,
  visitedBlocks: new Set(),
};

// Game-mode only. Two memories keep the cube navigable when the perpendicular
// channel gets re-picked on every landing:
//
// `gameTrail` is the stack of flips that led here, each with the full state
// it left behind. Flipping straight back the way you came pops it and restores
// that state exactly, so any route can be retraced flip for flip — however
// many times it crossed the same block.
//
// `gameBlockCache` remembers the last state seen on each block. Arriving at a
// known block some other way reuses its remembered perpendicular channel
// instead of picking a new one, so familiar blocks keep familiar neighbors.
const gameTrail = [];
const gameBlockCache = new Map();

function resetGameMemory() {
  gameTrail.length = 0;
  gameBlockCache.clear();
}

// The perpendicular axis to show when landing on a remembered block, having
// traveled along `axis` through the channel `keptSlug`. Prefers the channel
// that was on that axis last time; if that one is the channel we just came
// through (the block was last seen turned the other way), uses its partner.
function rememberedPerpendicular(remembered, axis, keptSlug) {
  if (!remembered) return null;
  const perp = axis === 'H' ? 'V' : 'H';
  for (const a of [perp, axis]) {
    const k = AXIS_KEYS[a];
    const channel = remembered[k.channel];
    if (channel && channel.slug !== keptSlug) {
      return { channel, blocks: remembered[k.blocks], idx: remembered[k.idx] };
    }
  }
  return null;
}

function checkWin() {
  if (!gameState.active || gameState.won) return;
  const id = cubeState.current?.id;
  if (id && gameState.destBlockIds.has(id)) {
    gameState.won = true;
    renderGamePanel();
    showGameResult();
  }
}

let promoting = false;
let wheelLocked = false;
async function onLanded(rx, ry) {
  if (promoting) return;
  if (rx === 0 && ry === 0) return;
  const tLand = performance.now();
  console.log(`[onLanded] start rx=${rx} ry=${ry}`);

  // Input only ever turns the cube a quarter turn on one axis (see `turn`).
  const axis = ry !== 0 ? 'H' : 'V';
  const dir = -Math.sign(ry !== 0 ? ry : rx);
  const perp = axis === 'H' ? 'V' : 'H';
  const k = AXIS_KEYS[axis];
  const flip = FLIPS[axis][dir];
  const from = cubeState.current;
  const target = cubeState.faces[flip.face];

  // The turn has landed; from here on the cube sits at rest and we swap the
  // faces underneath it instead.
  state.rotX = state.rotY = 0;
  state.targetX = state.targetY = 0;
  cube.rotation.set(0, 0, 0);

  // Nothing over there (axis failed to load, or a one-block channel): leave
  // every face as it was so the cube simply settles back on the same block.
  if (!from || !target || target.id === from.id) {
    wheelLocked = false;
    console.log('[onLanded] no-op — nothing to flip to');
    return;
  }

  const epoch = navEpoch;
  const inGame = gameState.active;
  promoting = true;
  // Retires the "swipe to flip" hint on small screens.
  document.body.classList.add('has-flipped');
  try {
    if (inGame && !gameState.won) {
      gameState.steps += 1;
      renderGamePanel();
    }
    const leaving = captureState();
    if (inGame) gameBlockCache.set(from.id, leaving);

    applyPermutation(flip.perm);
    const n = cubeState[k.blocks].length;
    cubeState[k.idx] = ((cubeState[k.idx] + dir) % n + n) % n;

    if (inGame) {
      // Flipping straight back: restore the state we left, untouched.
      const last = gameTrail[gameTrail.length - 1];
      if (last && last.axis === axis && last.dir === -dir && last.state.current.id === target.id) {
        gameTrail.pop();
        restoreState(last.state);
        populateNeighbors();
        updateMeta();
        checkWin();
        console.log(`[onLanded] undo — back on block ${target.id}`);
        return;
      }
      gameTrail.push({ axis, dir, state: leaving });

      // Been here before by another route: the axis we traveled stays (so
      // flipping back still returns to `from`), and the perpendicular comes
      // from memory rather than a fresh pick.
      const remembered = gameBlockCache.get(target.id);
      const perpAxis = rememberedPerpendicular(remembered, axis, cubeState[k.channel]?.slug);
      if (perpAxis) {
        cubeState.current = remembered.current;
        setAxis(perp, perpAxis);
        populateNeighbors();
        updateMeta();
        checkWin();
        console.log(`[onLanded] restored remembered axis for block ${target.id}`);
        return;
      }
    }

    // Keep the channel along the axis we just traveled through; only re-pick
    // the perpendicular one. The new block lives in the traveled channel
    // (it came from that axis's listing), but it has no relationship to the
    // old perpendicular channel — so picking a fresh one from its connections
    // gives the user a new orthogonal axis of exploration.
    //
    // Purge the meta that's about to change so the panel shows skeletons
    // until the new block and its perpendicular channel resolve. The old
    // perpendicular listing goes too: if the pick below fails, that axis must
    // read as empty rather than keep serving the previous block's neighbors.
    cubeState.current = null;
    cubeState.loadingCurrent = true;
    setAxis(perp, { channel: null, blocks: [], idx: 0 });
    cubeState[AXIS_KEYS[perp].loading] = true;
    updateMeta();

    // Block stubs from channel listings may lack a full connections array.
    // Refetch the full block so we have its channel list.
    let full = target;
    if (!full.connections || full.connections.length === 0) {
      console.log(`[onLanded] stub has no connections, refetching block ${target.id}`);
      const tFb = performance.now();
      try { full = await fetchBlock(target.id); }
      catch (e) { console.log(`[onLanded] fetchBlock failed: ${e.message}`); }
      console.log(`[onLanded] block refetch took ${Math.round(performance.now() - tFb)}ms`);
      if (epoch !== navEpoch) return;
    } else {
      console.log(`[onLanded] stub already has ${full.connections.length} connections, no refetch needed`);
    }
    cubeState.current = full;
    cubeState.loadingCurrent = false;
    if (inGame && full?.id) gameState.visitedBlocks.add(full.id);
    updateMeta();
    checkWin();

    const connections = getConnections(full);
    const keptSlug = cubeState[k.channel]?.slug;
    console.log(`[onLanded] ${connections.length} safe connections — kept ${axis}=${keptSlug}`);
    if (connections.length) {
      const pool = connections.filter(c => c.slug !== keptSlug);
      const pick = await pickSafeChannelWithContents(pool.length ? pool : connections, [], { deterministic: inGame });
      if (epoch !== navEpoch) return;
      if (pick) setAxis(perp, axisFromContents(pick.channel, pick.contents, full));
    }
    populateNeighbors();
  } finally {
    // A newer seed owns the cube (and these flags) if the epoch moved on.
    if (epoch === navEpoch) {
      // Always clear loading flags — even on early returns, this ensures the
      // skeletons resolve to whatever final state we ended up in (real value
      // or em-dash).
      cubeState.loadingCurrent = false;
      cubeState.loadingH = false;
      cubeState.loadingV = false;
      updateMeta();
      promoting = false;
      wheelLocked = false;
    }
    console.log(`[onLanded] done in ${Math.round(performance.now() - tLand)}ms — current=${cubeState.current?.id} loadingCurrent=${cubeState.loadingCurrent} loadingH=${cubeState.loadingH} loadingV=${cubeState.loadingV}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const GLITCH_CHARS = '!<>-_\\/[]{}=+*^?#@%&$~;:.ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
function randomGlitchText(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
  return s;
}
function loadingBlurSpan(len) {
  return `<span class="loading-blur">${randomGlitchText(len)}</span>`;
}

const FADE_MS = 180;
// Track the pending target per element so rapid-fire fadeSet calls compare
// against what's *about to be written*, not what's currently in the DOM.
// Without this, if call A schedules "write blur" and call B wants the same
// value the DOM already shows, B no-ops without cancelling A — and A's blur
// lands ~180ms later with no further updateMeta to clear it.
const fadePending = new WeakMap();
function fadeSet(el, newValue, asHtml = false) {
  const pending = fadePending.get(el);
  const current = pending ? pending.value : (asHtml ? el.innerHTML : el.textContent);
  if (current === newValue) return;
  if (pending) clearTimeout(pending.timer);
  el.style.opacity = '0';
  const timer = setTimeout(() => {
    if (asHtml) el.innerHTML = newValue;
    else el.textContent = newValue;
    el.style.opacity = '1';
    fadePending.delete(el);
  }, FADE_MS);
  fadePending.set(el, { timer, value: newValue });
}

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function updateMeta() {
  console.log(`[updateMeta] current=${cubeState.current?.id ?? 'null'} loadingCurrent=${cubeState.loadingCurrent} channelH=${cubeState.channelH?.slug ?? 'null'}/loadingH=${cubeState.loadingH} channelV=${cubeState.channelV?.slug ?? 'null'}/loadingV=${cubeState.loadingV}`);
  const t = document.getElementById('meta-title');
  const author = document.getElementById('meta-author');
  const created = document.getElementById('meta-created');
  const axisH = document.getElementById('meta-axis-h');
  const axisV = document.getElementById('meta-axis-v');
  const b = cubeState.current;
  if (b) {
    fadeSet(t, b.title || `Block ${b.id}`);
    const userName = b.user?.full_name || b.user?.username;
    fadeSet(author, userName ? `by ${userName}` : '', true);
    const when = formatDate(b.created_at || b.connected_at);
    fadeSet(created, when ? `created ${when}` : '', true);
  } else if (cubeState.loadingCurrent) {
    fadeSet(t, loadingBlurSpan(18), true);
    fadeSet(author, loadingBlurSpan(14), true);
    fadeSet(created, loadingBlurSpan(20), true);
  } else {
    fadeSet(t, 'loading…');
    fadeSet(author, '', true);
    fadeSet(created, '', true);
  }
  const h = cubeState.channelH?.title;
  const v = cubeState.channelV?.title;
  const hBody = h
    ? escapeHtml(h)
    : (cubeState.loadingH ? loadingBlurSpan(10) : '—');
  const vBody = v
    ? escapeHtml(v)
    : (cubeState.loadingV ? loadingBlurSpan(10) : '—');
  fadeSet(axisH, `<span class="axis-icon">↔</span>${hBody}`, true);
  fadeSet(axisV, `<span class="axis-icon axis-icon--v">↔</span>${vBody}`, true);
}

// ---------- rotation state ----------
const state = {
  rotX: 0, rotY: 0,
  targetX: 0, targetY: 0,
  dragging: false,
  lastInputAt: 0,
};

const SNAP_IDLE_MS = 220;
function tick(now) {
  if (!state.dragging && now - state.lastInputAt > SNAP_IDLE_MS) {
    state.targetX = Math.round(state.targetX / HALF_PI) * HALF_PI;
    state.targetY = Math.round(state.targetY / HALF_PI) * HALF_PI;
  }
  state.rotX += (state.targetX - state.rotX) * 0.12;
  state.rotY += (state.targetY - state.rotY) * 0.12;
  cube.rotation.x = state.rotX;
  cube.rotation.y = state.rotY;

  const settled = Math.abs(state.targetX - state.rotX) < 0.0008 && Math.abs(state.targetY - state.rotY) < 0.0008;
  if (settled && !state.dragging && now - state.lastInputAt > SNAP_IDLE_MS && !promoting) {
    const rx = Math.round(state.targetX / HALF_PI);
    const ry = Math.round(state.targetY / HALF_PI);
    if (rx !== 0 || ry !== 0) onLanded(rx, ry);
  }

  flushQueuedTurn();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- input ----------
// Every input funnels into a single quarter turn on a single axis. Turning
// further, or on both axes at once, would move the cube somewhere its channel
// listings can't account for — so a turn only starts from rest.
function cubeBusy() {
  return promoting || wheelLocked || state.dragging
    || Math.abs(state.targetX) > 0.01 || Math.abs(state.targetY) > 0.01;
}

// `axis` is the rotation axis: 'y' turns left/right, 'x' turns up/down.
function turn(axis, sign) {
  if (axis === 'y') state.targetY = sign * HALF_PI;
  else state.targetX = sign * HALF_PI;
  state.lastInputAt = performance.now();
}

const WHEEL_THRESHOLD = 4;
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (cubeBusy()) return;
  const ax = Math.abs(e.deltaX);
  const ay = Math.abs(e.deltaY);
  if (ax < WHEEL_THRESHOLD && ay < WHEEL_THRESHOLD) return;
  if (ay >= ax) turn('x', -Math.sign(e.deltaY));
  else turn('y', Math.sign(e.deltaX));
  wheelLocked = true;
}, { passive: false });

// Arrow keys pressed mid-flip wait for the cube to come to rest rather than
// stacking onto the turn in progress. Only the latest press is kept.
const KEY_TURNS = {
  ArrowRight: ['y', -1],
  ArrowLeft: ['y', 1],
  ArrowDown: ['x', -1],
  ArrowUp: ['x', 1],
};
let queuedTurn = null;
window.addEventListener('keydown', (e) => {
  const tags = ['INPUT', 'TEXTAREA', 'BUTTON'];
  if (tags.includes(document.activeElement?.tagName)) return;
  const t = KEY_TURNS[e.key];
  if (!t) return;
  if (cubeBusy()) queuedTurn = t;
  else turn(...t);
});
function flushQueuedTurn() {
  if (!queuedTurn || cubeBusy()) return;
  const t = queuedTurn;
  queuedTurn = null;
  turn(...t);
}

const DRAG_AXIS_THRESHOLD = 6;
const DRAG_SENSITIVITY = 0.006;
// A short, quick swipe counts as a full flip even if it didn't drag the cube
// past the halfway point — on a phone that would take a third of the screen.
const FLICK_MAX_MS = 350;
const FLICK_MIN_PX = 28;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let dragStart = null;
canvas.addEventListener('pointerdown', (e) => {
  if (cubeBusy()) return;
  state.dragging = true;
  dragStart = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: null };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.dragging || !dragStart || e.pointerId !== dragStart.id) return;
  const totalDx = e.clientX - dragStart.x;
  const totalDy = e.clientY - dragStart.y;
  if (!dragStart.axis) {
    if (Math.abs(totalDx) < DRAG_AXIS_THRESHOLD && Math.abs(totalDy) < DRAG_AXIS_THRESHOLD) return;
    dragStart.axis = Math.abs(totalDx) >= Math.abs(totalDy) ? 'y' : 'x';
  }
  if (dragStart.axis === 'y') {
    state.targetY = clamp(totalDx * DRAG_SENSITIVITY, -HALF_PI, HALF_PI);
    state.targetX = 0;
  } else {
    state.targetX = clamp(totalDy * DRAG_SENSITIVITY, -HALF_PI, HALF_PI);
    state.targetY = 0;
  }
  state.lastInputAt = performance.now();
});
function endDrag(e) {
  if (!dragStart || e.pointerId !== dragStart.id) return;
  const { axis, x, y, t } = dragStart;
  state.dragging = false;
  dragStart = null;
  state.lastInputAt = performance.now();
  if (e.type === 'pointercancel') {
    // The browser took the gesture over; let the cube fall back to rest.
    state.targetX = state.targetY = 0;
    return;
  }
  if (!axis) return;
  const travel = axis === 'y' ? e.clientX - x : e.clientY - y;
  if (performance.now() - t <= FLICK_MAX_MS && Math.abs(travel) >= FLICK_MIN_PX) {
    turn(axis, Math.sign(travel));
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- entry form ----------
const form = document.getElementById('entry');
const input = document.getElementById('entry-input');
const randomBtn = document.getElementById('entry-random');

async function startWithBlockId(id) {
  document.getElementById('meta-title').textContent = `fetching ${id}…`;
  try {
    const block = await fetchBlock(id);
    await seed(block);
  } catch (e) {
    document.getElementById('meta-title').textContent = `could not fetch block: ${e.message}`;
  }
}

async function startWithChannelSlug(slug) {
  document.getElementById('meta-title').textContent = `fetching ${slug}…`;
  try {
    const contents = await fetchChannelContents(slug, 1, 100);
    const blocks = (contents.contents || []).filter(b => b.class === 'Image' && b.image);
    if (!blocks.length) {
      document.getElementById('meta-title').textContent = `no image blocks in ${slug}`;
      return;
    }
    // Channel contents are stubs without a full connections array; refetch the
    // chosen block so seed() can find its neighbour channels.
    const stub = blocks[Math.floor(Math.random() * blocks.length)];
    const block = await fetchBlock(stub.id);
    await seed(block);
  } catch (e) {
    document.getElementById('meta-title').textContent = `could not fetch channel: ${e.message}`;
  }
}

async function startRandom() {
  document.getElementById('meta-title').textContent = 'finding a random block…';
  try {
    const block = await pickRandomBlock();
    await seed(block);
  } catch (e) {
    document.getElementById('meta-title').textContent = `random failed: ${e.message}`;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (gameState.active) return;
  const id = parseBlockInput(input.value);
  if (id) { startWithBlockId(id); return; }
  const slug = parseChannelInput(input.value);
  if (slug) { startWithChannelSlug(slug); return; }
  document.getElementById('meta-title').textContent = 'paste an are.na block or channel URL';
});
randomBtn.addEventListener('click', () => {
  if (gameState.active) return;
  startRandom();
});

// ---------- game mode UI ----------
const playBtn = document.getElementById('entry-play');
const goBtn = document.getElementById('entry-go');
const gamePanel = document.getElementById('game-panel');
const gameGoalChannel = document.getElementById('game-goal-channel');
const gameStepsEl = document.getElementById('game-steps');
const gameStepsLabel = document.getElementById('game-steps-label');
const gameDistanceEl = document.getElementById('game-distance');
const gameDistanceLabel = document.getElementById('game-distance-label');
const gameExitBtn = document.getElementById('game-exit');

// Distance from the current block to a block in destChannel.
//
// Primary signal is the *constructed solution path*: at game start the user
// is on `path[0]`, so distance = `path.length - 1` (= the configured hop
// count). Each correct flip lands them on the next path block, dropping
// distance by one. Using the path keeps the stat at exactly N at game start
// instead of dipping below (when the scan finds a closer destBlock in the
// visible axes) or jumping to "many" (when the scan can't see one).
//
// When the user steps off the path we fall back to a local scan: visible
// cube neighbors first, then further along the loaded H/V channels. Returns
// null when nothing reachable is in view — we render that as "many".
function computeFlipsAway() {
  if (!gameState.active) return null;
  const cur = cubeState.current;
  if (!cur) return null;
  const dest = gameState.destBlockIds;
  if (!dest || !dest.size) return null;
  if (dest.has(cur.id)) return 0;

  const path = gameState.path;
  if (path && path.length) {
    const i = path.indexOf(cur.id);
    if (i !== -1) return path.length - 1 - i;
  }

  let best = Infinity;
  for (const f of ['top', 'bottom', 'left', 'right']) {
    const n = cubeState.faces[f];
    if (n && dest.has(n.id)) best = Math.min(best, 1);
  }
  const scanChannel = (blocks, idx) => {
    const n = blocks.length;
    if (n < 2) return;
    const max = Math.floor(n / 2);
    for (let k = 1; k <= max && k < best; k++) {
      if (dest.has(blocks[(idx + k) % n].id) || dest.has(blocks[((idx - k) % n + n) % n].id)) {
        best = k;
        return;
      }
    }
  };
  scanChannel(cubeState.blocksH, cubeState.idxH);
  scanChannel(cubeState.blocksV, cubeState.idxV);
  return Number.isFinite(best) ? best : null;
}

// Write a scoreboard number, giving it a brief pulse when it actually changes
// so the eye catches the score moving.
function setStat(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('bump');
  void el.offsetWidth; // restart the animation
  el.classList.add('bump');
}

let shownGoal = null;
function renderGamePanel() {
  const goal = gameState.active ? (gameState.destChannel?.title || '—') : null;
  document.body.classList.toggle('game-active', gameState.active);
  gamePanel.hidden = !gameState.active;
  if (gameState.active) {
    gameGoalChannel.textContent = goal;
    setStat(gameStepsEl, String(gameState.steps));
    gameStepsLabel.textContent = gameState.steps === 1 ? 'flip made' : 'flips made';
    gameExitBtn.textContent = gameState.won ? 'done' : 'give up';
    const d = computeFlipsAway();
    setStat(gameDistanceEl, d == null ? 'many' : String(d));
    gameDistanceLabel.textContent = d === 1 ? 'flip away' : 'flips away';
  }
  // The panel appearing, leaving, or changing goal changes how much room the
  // cube has on small screens.
  if (goal !== shownGoal) {
    shownGoal = goal;
    layoutCube();
  }
}

const gameResult = document.getElementById('game-result');
const gameResultChannel = document.getElementById('game-result-channel');
const statFlips = document.getElementById('stat-flips');
const statBlocks = document.getElementById('stat-blocks');
const gameResultAgain = document.getElementById('game-result-again');
const gameResultClose = document.getElementById('game-result-close');

function showGameResult() {
  gameResultChannel.textContent = gameState.destChannel?.title || '—';
  statFlips.textContent = String(gameState.steps);
  statBlocks.textContent = String(gameState.visitedBlocks.size);
  gameResult.hidden = false;
}

function hideGameResult() {
  gameResult.hidden = true;
}

function setEntryDisabled(disabled) {
  input.disabled = disabled;
  goBtn.disabled = disabled;
  randomBtn.disabled = disabled;
  playBtn.disabled = disabled;
}

const TARGET_HOPS = 5;
async function buildGameScenario() {
  // Walk TARGET_HOPS channel-hops away from a random starting block to derive
  // a destination channel that is reachable from the start in that many flips.
  for (let i = 0; i < 5; i++) {
    try {
      const setup = await pickGameSetup(TARGET_HOPS);
      if (setup) return setup;
    } catch (e) { /* retry */ }
  }
  throw new Error('could not build a game');
}

const gameLoading = document.getElementById('game-loading');
async function startGame() {
  if (gameState.active) return;
  setEntryDisabled(true);
  gameLoading.hidden = false;
  document.getElementById('meta-title').textContent = 'setting up the game…';
  try {
    const { startBlock, destChannel, destBlockIds, walkedPath } = await buildGameScenario();
    gameState.active = true;
    gameState.destChannel = destChannel;
    gameState.destBlockIds = destBlockIds;
    gameState.path = walkedPath || [];
    gameState.steps = 0;
    gameState.won = false;
    gameState.visitedBlocks = new Set();
    resetGameMemory();
    hideGameResult();
    renderGamePanel();
    // Re-enable only the exit button; entry stays disabled while playing.
    playBtn.disabled = true;
    await seed(startBlock);
  } catch (e) {
    document.getElementById('meta-title').textContent = `game setup failed: ${e.message}`;
    setEntryDisabled(false);
    gameState.active = false;
    renderGamePanel();
  } finally {
    gameLoading.hidden = true;
  }
}

function exitGame() {
  gameState.active = false;
  gameState.destChannel = null;
  gameState.destBlockIds = new Set();
  gameState.path = [];
  gameState.steps = 0;
  gameState.won = false;
  gameState.visitedBlocks = new Set();
  resetGameMemory();
  renderGamePanel();
  hideGameResult();
  setEntryDisabled(false);
}

playBtn.addEventListener('click', startGame);
gameExitBtn.addEventListener('click', exitGame);

const gameDebugWinBtn = document.getElementById('game-debug-win');
gameDebugWinBtn.addEventListener('click', () => {
  if (!gameState.active || gameState.won) return;
  gameState.won = true;
  renderGamePanel();
  showGameResult();
});
gameResultClose.addEventListener('click', exitGame);
gameResultAgain.addEventListener('click', () => {
  hideGameResult();
  exitGame();
  startGame();
});

startRandom();
