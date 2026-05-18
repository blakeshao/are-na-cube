import * as THREE from 'three';
import { blockImageUrl } from './arena.js';

const FACE_PX = 1024;

export function createFaceTextures(renderer, faceNames) {
  const out = {};
  for (const name of faceNames) {
    const c = document.createElement('canvas');
    c.width = c.height = FACE_PX;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1a1c';
    ctx.fillRect(0, 0, FACE_PX, FACE_PX);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    out[name] = { canvas: c, ctx, texture: tex };
  }
  return out;
}

const FACE_PADDING = 64;
function drawImageCovering(ctx, img) {
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, FACE_PX, FACE_PX);
  const inner = FACE_PX - FACE_PADDING * 2;
  // VideoFrame uses displayWidth/Height; HTMLImageElement uses width/height.
  const iw = img.displayWidth || img.width;
  const ih = img.displayHeight || img.height;
  const ratio = Math.min(inner / iw, inner / ih);
  const w = iw * ratio, h = ih * ratio;
  const x = (FACE_PX - w) / 2, y = (FACE_PX - h) / 2;
  ctx.drawImage(img, x, y, w, h);
}

function drawPlaceholder(ctx, label) {
  ctx.fillStyle = '#15151a';
  ctx.fillRect(0, 0, FACE_PX, FACE_PX);
  ctx.fillStyle = '#3a3a42';
  ctx.font = '40px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = (label || '…').slice(0, 40);
  ctx.fillText(text, FACE_PX / 2, FACE_PX / 2);
}

const imageCache = new Map();
// Synchronously-readable cache of fully-loaded images. Lets paintFace skip
// the placeholder step entirely when the target image is already in memory
// (the common case after navigation, since neighbors prefetch eagerly).
const imageReady = new Map();
function loadImage(url) {
  if (imageCache.has(url)) {
    const ready = imageReady.has(url);
    console.log(`[img] cache ${ready ? 'hit (ready)' : 'hit (pending)'}: ${url.slice(0, 80)}`);
    return imageCache.get(url);
  }
  console.log(`[img] fetching: ${url.slice(0, 80)}`);
  const t0 = performance.now();
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageReady.set(url, img);
      console.log(`[img] loaded in ${Math.round(performance.now() - t0)}ms: ${url.slice(0, 80)}`);
      resolve(img);
    };
    img.onerror = () => {
      console.log(`[img] failed after ${Math.round(performance.now() - t0)}ms: ${url.slice(0, 80)}`);
      reject(new Error('img load'));
    };
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
}

function isAnimatedImage(block, url) {
  const ct = block?.image?.content_type;
  if (ct === 'image/gif' || ct === 'image/webp' || ct === 'image/apng') return true;
  if (!url) return false;
  const path = url.split('?')[0].toLowerCase();
  return path.endsWith('.gif') || path.endsWith('.apng');
}

// Decode every frame of a GIF/animated image into VideoFrame objects with
// per-frame durations. We use ImageDecoder because `ctx.drawImage` on a
// detached <img> does NOT reliably sample successive GIF frames — most
// browsers freeze the animation when the element isn't being rendered.
const gifFramesCache = new Map();
function loadAnimatedFrames(url) {
  if (gifFramesCache.has(url)) return gifFramesCache.get(url);
  if (typeof ImageDecoder === 'undefined') {
    return Promise.reject(new Error('ImageDecoder unavailable'));
  }
  console.log(`[gif] decoding: ${url.slice(0, 80)}`);
  const t0 = performance.now();
  const p = (async () => {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    const type = response.headers.get('content-type') || 'image/gif';
    const decoder = new ImageDecoder({ data: response.body, type });
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const count = track.frameCount;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const result = await decoder.decode({ frameIndex: i });
      // VideoFrame.duration is in microseconds. GIFs with a 0 duration are
      // sometimes encoded — fall back to a sane default so the loop advances.
      const durationMs = result.image.duration ? result.image.duration / 1000 : 100;
      frames.push({ image: result.image, duration: Math.max(20, durationMs) });
    }
    const totalDuration = frames.reduce((s, f) => s + f.duration, 0);
    console.log(`[gif] decoded ${count} frames in ${Math.round(performance.now() - t0)}ms (total ${Math.round(totalDuration)}ms): ${url.slice(0, 80)}`);
    return { frames, totalDuration };
  })();
  gifFramesCache.set(url, p);
  p.catch(() => gifFramesCache.delete(url));
  return p;
}

// Faces currently showing an animated image. The rAF loop advances each
// face's frame index according to elapsed wall-clock time and the per-frame
// durations baked into the decoded GIF.
const animatedFaces = new Map();
let animationRunning = false;
function startAnimationLoop() {
  if (animationRunning) return;
  animationRunning = true;
  const tick = (now) => {
    if (animatedFaces.size === 0) { animationRunning = false; return; }
    for (const [, entry] of animatedFaces) {
      const t = ((now - entry.startTime) % entry.totalDuration);
      let acc = 0;
      let idx = entry.frames.length - 1;
      for (let i = 0; i < entry.frames.length; i++) {
        acc += entry.frames[i].duration;
        if (t < acc) { idx = i; break; }
      }
      if (idx !== entry.lastIdx) {
        drawImageCovering(entry.ft.ctx, entry.frames[idx].image);
        entry.ft.texture.needsUpdate = true;
        entry.lastIdx = idx;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function setAnimatedFace(faceName, ft, frames, totalDuration) {
  animatedFaces.set(faceName, {
    ft, frames, totalDuration,
    startTime: performance.now(),
    lastIdx: -1,
  });
  startAnimationLoop();
}
function clearAnimatedFace(faceName) {
  animatedFaces.delete(faceName);
}

async function startGifOnFace(faceName, ft, url, token) {
  try {
    const { frames, totalDuration } = await loadAnimatedFrames(url);
    if (paintTokens[faceName] !== token) return;
    setAnimatedFace(faceName, ft, frames, totalDuration);
  } catch (e) {
    console.log(`[gif] decode failed: ${e.message} — ${url.slice(0, 80)}`);
  }
}

const paintTokens = {};
const lastPaintedBlockId = {};
export async function paintFace(faceTextures, faceName, block) {
  const ft = faceTextures[faceName];
  const newId = block ? block.id : null;
  // No-op if this face is already showing this block — avoids the placeholder
  // flicker when a permutation leaves a face unchanged (e.g. top/bottom on a
  // horizontal rotation).
  if (lastPaintedBlockId[faceName] === newId) return;
  lastPaintedBlockId[faceName] = newId;
  clearAnimatedFace(faceName);
  const token = (paintTokens[faceName] = (paintTokens[faceName] || 0) + 1);
  if (!block) {
    drawPlaceholder(ft.ctx, '—');
    ft.texture.needsUpdate = true;
    return;
  }
  const url = blockImageUrl(block);
  const animated = isAnimatedImage(block, url);
  const ready = url ? imageReady.get(url) : null;
  if (ready) {
    drawImageCovering(ft.ctx, ready);
    ft.texture.needsUpdate = true;
    if (animated) startGifOnFace(faceName, ft, url, token);
    return;
  }
  console.log(`[paint] face=${faceName} block=${block.id} — showing placeholder, image not ready`);
  drawPlaceholder(ft.ctx, block.title || block.class || '');
  ft.texture.needsUpdate = true;
  if (!url) return;
  try {
    const img = await loadImage(url);
    if (paintTokens[faceName] !== token) return;
    drawImageCovering(ft.ctx, img);
    ft.texture.needsUpdate = true;
    if (animated) startGifOnFace(faceName, ft, url, token);
  } catch (e) {
    if (paintTokens[faceName] !== token) return;
    drawPlaceholder(ft.ctx, 'image unavailable');
    ft.texture.needsUpdate = true;
  }
}
