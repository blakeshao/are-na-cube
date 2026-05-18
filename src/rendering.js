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
  const ratio = Math.min(inner / img.width, inner / img.height);
  const w = img.width * ratio, h = img.height * ratio;
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
  if (imageCache.has(url)) return imageCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imageReady.set(url, img); resolve(img); };
    img.onerror = () => reject(new Error('img load'));
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
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
  const token = (paintTokens[faceName] = (paintTokens[faceName] || 0) + 1);
  if (!block) {
    drawPlaceholder(ft.ctx, '—');
    ft.texture.needsUpdate = true;
    return;
  }
  const url = blockImageUrl(block);
  const ready = url ? imageReady.get(url) : null;
  if (ready) {
    drawImageCovering(ft.ctx, ready);
    ft.texture.needsUpdate = true;
    return;
  }
  drawPlaceholder(ft.ctx, block.title || block.class || '');
  ft.texture.needsUpdate = true;
  if (!url) return;
  try {
    const img = await loadImage(url);
    if (paintTokens[faceName] !== token) return;
    drawImageCovering(ft.ctx, img);
    ft.texture.needsUpdate = true;
  } catch (e) {
    if (paintTokens[faceName] !== token) return;
    drawPlaceholder(ft.ctx, 'image unavailable');
    ft.texture.needsUpdate = true;
  }
}
