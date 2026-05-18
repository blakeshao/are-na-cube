import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createFaceTextures } from './rendering.js';

const CUBE_SIZE = 2.4;
const INNER_CUBE_SIZE = 1.7;
const HALF = CUBE_SIZE / 2;
export const HALF_PI = Math.PI / 2;
export const FACES = ['front', 'right', 'back', 'left', 'top', 'bottom'];

const DECAL_OFFSET = 0.006;
const DECAL_PLACEMENT = {
  front:  { pos: [ 0,  0,  HALF + DECAL_OFFSET], rot: [0, 0, 0] },
  right:  { pos: [ HALF + DECAL_OFFSET,  0,  0], rot: [0,  HALF_PI, 0] },
  back:   { pos: [ 0,  0, -HALF - DECAL_OFFSET], rot: [0, Math.PI, 0] },
  left:   { pos: [-HALF - DECAL_OFFSET,  0,  0], rot: [0, -HALF_PI, 0] },
  top:    { pos: [ 0,  HALF + DECAL_OFFSET,  0], rot: [-HALF_PI, 0, 0] },
  bottom: { pos: [ 0, -HALF - DECAL_OFFSET,  0], rot: [ HALF_PI, 0, 0] },
};

export const FACE_NORMALS = {
  front:  [ 0,  0,  1],
  right:  [ 1,  0,  0],
  back:   [ 0,  0, -1],
  left:   [-1,  0,  0],
  top:    [ 0,  1,  0],
  bottom: [ 0, -1,  0],
};

function makeFogRoughnessMap(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 28; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 80 + Math.random() * 220;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 24;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i+1] = img.data[i];
    img.data[i+2] = img.data[i];
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0a0c');

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0.4, 6);
  camera.lookAt(0, 0, 0);

  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb8c4ff, 0.4);
  fill.position.set(-4, 2, -2);
  scene.add(fill);

  const cube = new THREE.Group();
  scene.add(cube);

  const innerGeo = new THREE.BoxGeometry(INNER_CUBE_SIZE, INNER_CUBE_SIZE, INNER_CUBE_SIZE);
  const innerMat = new THREE.MeshBasicMaterial({ color: 0xf3f4f6 });
  cube.add(new THREE.Mesh(innerGeo, innerMat));

  const fogMap = makeFogRoughnessMap(1024);
  const glassGeo = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.55,
    roughnessMap: fogMap,
    transmission: 1.0,
    thickness: 0.9,
    ior: 1.45,
    attenuationDistance: 5.0,
    attenuationColor: new THREE.Color(0xeaf2ff),
    clearcoat: 0.4,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.0,
    side: THREE.FrontSide,
    transparent: false,
  });
  cube.add(new THREE.Mesh(glassGeo, glassMat));

  const edgeThickness = 0.01;
  const dashCount = 30;
  const slot = CUBE_SIZE / dashCount;
  const dashLength = slot * 0.55;
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const dashGeos = {
    x: new THREE.BoxGeometry(dashLength, edgeThickness, edgeThickness),
    y: new THREE.BoxGeometry(edgeThickness, dashLength, edgeThickness),
    z: new THREE.BoxGeometry(edgeThickness, edgeThickness, dashLength),
  };
  for (const axis of ['x', 'y', 'z']) {
    for (const a of [-HALF, HALF]) {
      for (const b of [-HALF, HALF]) {
        for (let i = 0; i < dashCount; i++) {
          const t = -HALF + slot * (i + 0.5);
          const mesh = new THREE.Mesh(dashGeos[axis], edgeMat);
          if (axis === 'x') mesh.position.set(t, a, b);
          else if (axis === 'y') mesh.position.set(a, t, b);
          else mesh.position.set(a, b, t);
          mesh.renderOrder = 2;
          cube.add(mesh);
        }
      }
    }
  }

  const faceTextures = createFaceTextures(renderer, FACES);
  for (const name of FACES) {
    const placement = DECAL_PLACEMENT[name];
    const geo = new THREE.PlaneGeometry(CUBE_SIZE, CUBE_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      map: faceTextures[name].texture,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...placement.pos);
    mesh.rotation.set(...placement.rot);
    mesh.renderOrder = 1;
    cube.add(mesh);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  renderer.setSize(window.innerWidth, window.innerHeight);

  return { renderer, scene, camera, cube, faceTextures };
}
