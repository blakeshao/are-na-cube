import {
  fetchBlock,
  parseBlockInput,
  parseChannelInput,
  pickRandomBlock,
  fetchChannelContents,
  getConnections,
  pickSafeChannelWithContents,
} from './arena.js';
import { paintFace } from './rendering.js';
import { createScene, FACES, HALF_PI } from './cube3d.js';

const canvas = document.getElementById('stage');
const { renderer, scene, camera, cube, faceTextures } = createScene(canvas);

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

function setBlocksFromContents(data, block, which) {
  const blocks = (data.contents || []).filter(b => b.class === 'Image' && b.image);
  const idx = blocks.findIndex(b => b.id === block.id);
  if (which === 'H') { cubeState.blocksH = blocks.length ? blocks : [block]; cubeState.idxH = idx >= 0 ? idx : 0; }
  else { cubeState.blocksV = blocks.length ? blocks : [block]; cubeState.idxV = idx >= 0 ? idx : 0; }
}

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
}

async function seed(block) {
  cubeState.current = block;
  cubeState.loadingCurrent = false;
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
    if (!connections.length) return;
    const hPick = await pickSafeChannelWithContents(connections);
    if (!hPick) return;
    cubeState.channelH = hPick.channel;
    cubeState.loadingH = false;
    const vPick = await pickSafeChannelWithContents(connections, [hPick.channel.slug]) || hPick;
    cubeState.channelV = vPick.channel;
    cubeState.loadingV = false;

    setBlocksFromContents(hPick.contents, block, 'H');
    setBlocksFromContents(vPick.contents, block, 'V');
    populateNeighbors();
  } finally {
    cubeState.loadingH = false;
    cubeState.loadingV = false;
    updateMeta();
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

function applyPermutation(key) {
  const p = PERMUTE[key];
  const old = { ...cubeState.faces };
  const next = {};
  for (const f of FACES) next[f] = old[p[f]];
  cubeState.faces = next;
  for (const f of FACES) paint(f, next[f]);
}

let promoting = false;
let wheelLocked = false;
async function onLanded(rx, ry) {
  if (promoting) return;
  if (rx === 0 && ry === 0) return;
  promoting = true;
  try {
    if (ry !== 0) {
      const key = ry < 0 ? 'y-1' : 'y+1';
      for (let i = 0; i < Math.abs(ry); i++) applyPermutation(key);
      if (cubeState.blocksH.length) {
        const n = cubeState.blocksH.length;
        cubeState.idxH = ((cubeState.idxH - ry) % n + n) % n;
      }
    }
    if (rx !== 0) {
      const key = rx > 0 ? 'x+1' : 'x-1';
      for (let i = 0; i < Math.abs(rx); i++) applyPermutation(key);
      if (cubeState.blocksV.length) {
        const n = cubeState.blocksV.length;
        cubeState.idxV = ((cubeState.idxV - rx) % n + n) % n;
      }
    }

    state.rotX = state.rotY = 0;
    state.targetX = state.targetY = 0;
    cube.rotation.set(0, 0, 0);

    const newCurrent = cubeState.faces.front;
    if (!newCurrent || (cubeState.current && newCurrent.id === cubeState.current.id)) return;

    // Keep the channel along the axis we just traveled through; only re-pick
    // the perpendicular one. The new block lives in the traveled channel
    // (it came from blocksH/blocksV), but it has no relationship to the old
    // perpendicular channel — so picking a fresh one from its connections
    // gives the user a new orthogonal axis of exploration.
    const keepH = ry !== 0;
    const keepV = rx !== 0;

    // Purge the meta that's about to change so the panel shows skeletons
    // until the new block (and its re-picked perpendicular channel) resolve.
    // The traveled axis stays — the new block lives inside that channel.
    cubeState.current = null;
    cubeState.loadingCurrent = true;
    if (!keepH) { cubeState.channelH = null; cubeState.loadingH = true; }
    if (!keepV) { cubeState.channelV = null; cubeState.loadingV = true; }
    updateMeta();

    try {
      // Block stubs from channel listings may lack a full connections array.
      // Refetch the full block so we have its channel list.
      let full = newCurrent;
      if (!full.connections || full.connections.length === 0) {
        try { full = await fetchBlock(newCurrent.id); }
        catch (e) { /* keep stub */ }
      }
      cubeState.current = full;
      cubeState.loadingCurrent = false;
      updateMeta();
      const connections = getConnections(full);
      if (!connections.length) return;

      if (keepH && keepV) {
        populateNeighbors();
        return;
      }

      const keptSlug = keepH ? cubeState.channelH?.slug : cubeState.channelV?.slug;
      const pool = connections.filter(c => c.slug !== keptSlug);
      const pick = await pickSafeChannelWithContents(pool.length ? pool : connections);
      if (!pick) {
        populateNeighbors();
        return;
      }

      if (keepH) {
        cubeState.channelV = pick.channel;
        setBlocksFromContents(pick.contents, full, 'V');
      } else {
        cubeState.channelH = pick.channel;
        setBlocksFromContents(pick.contents, full, 'H');
      }
      populateNeighbors();
    } finally {
      // Always clear loading flags — even on early returns, this ensures the
      // skeletons resolve to whatever final state we ended up in (real value
      // or em-dash).
      cubeState.loadingCurrent = false;
      cubeState.loadingH = false;
      cubeState.loadingV = false;
      updateMeta();
    }
  } finally {
    promoting = false;
    wheelLocked = false;
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
const fadeTimers = new WeakMap();
function fadeSet(el, newValue, asHtml = false) {
  const current = asHtml ? el.innerHTML : el.textContent;
  if (current === newValue) return;
  const prev = fadeTimers.get(el);
  if (prev) clearTimeout(prev);
  el.style.opacity = '0';
  const t = setTimeout(() => {
    if (asHtml) el.innerHTML = newValue;
    else el.textContent = newValue;
    el.style.opacity = '1';
    fadeTimers.delete(el);
  }, FADE_MS);
  fadeTimers.set(el, t);
}

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function updateMeta() {
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

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- input ----------
const WHEEL_THRESHOLD = 4;
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (wheelLocked || promoting) return;
  const ax = Math.abs(e.deltaX);
  const ay = Math.abs(e.deltaY);
  if (ax < WHEEL_THRESHOLD && ay < WHEEL_THRESHOLD) return;
  if (ay >= ax) {
    state.targetX = Math.sign(e.deltaY) * HALF_PI;
  } else {
    state.targetY = Math.sign(e.deltaX) * HALF_PI;
  }
  wheelLocked = true;
  state.lastInputAt = performance.now();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const tags = ['INPUT', 'TEXTAREA', 'BUTTON'];
  if (tags.includes(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') state.targetY -= HALF_PI;
  else if (e.key === 'ArrowLeft') state.targetY += HALF_PI;
  else if (e.key === 'ArrowDown') state.targetX += HALF_PI;
  else if (e.key === 'ArrowUp') state.targetX -= HALF_PI;
  else return;
  state.lastInputAt = performance.now();
});

const DRAG_AXIS_THRESHOLD = 6;
const DRAG_SENSITIVITY = 0.006;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let dragStart = null;
canvas.addEventListener('pointerdown', (e) => {
  if (promoting || wheelLocked) return;
  if (Math.abs(state.targetX) > 0.01 || Math.abs(state.targetY) > 0.01) return;
  state.dragging = true;
  dragStart = { x: e.clientX, y: e.clientY, axis: null };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.dragging || !dragStart) return;
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
    state.targetX = clamp(-totalDy * DRAG_SENSITIVITY, -HALF_PI, HALF_PI);
    state.targetY = 0;
  }
  state.lastInputAt = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  state.dragging = false;
  dragStart = null;
  state.lastInputAt = performance.now();
});

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
  const id = parseBlockInput(input.value);
  if (id) { startWithBlockId(id); return; }
  const slug = parseChannelInput(input.value);
  if (slug) { startWithChannelSlug(slug); return; }
  document.getElementById('meta-title').textContent = 'paste an are.na block or channel URL';
});
randomBtn.addEventListener('click', startRandom);

startRandom();
