import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// ===================== 1. SETTINGS & SAVE STORAGE =====================
const CFG_KEY = 'igi2_real_cfg_v1';
const SAVE_KEY = 'igi2_real_save_v1';
const getStore = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
const setStore = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

let settings = Object.assign({
  preset: 'med', resScale: 1.0, shadowSize: 1024, snow: true, drawDist: 120, sens: 1.0
}, getStore(CFG_KEY) || {});

// ===================== 2. SYNTH AUDIO =====================
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function playSfx(type) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  if (type === 'mp5' || type === 'enemy') {
    const dur = type === 'mp5' ? 0.068 : 0.14;
    const len = Math.floor(audioCtx.sampleRate * dur);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.24));
    const n = audioCtx.createBufferSource(); n.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = type === 'mp5' ? 'bandpass' : 'lowpass';
    f.frequency.setValueAtTime(type === 'mp5' ? 1200 : 850, now);
    const g = audioCtx.createGain(); g.gain.setValueAtTime(0.32, now); g.gain.exponentialRampToValueAtTime(0.01, now + dur);
    n.connect(f); f.connect(g); g.connect(audioCtx.destination); n.start(now);
  } else if (type === 'head' || type === 'hit') {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(type === 'head' ? 1500 : 720, now);
    g.gain.setValueAtTime(0.16, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    o.connect(g); g.connect(audioCtx.destination); o.start(now); o.stop(now + 0.085);
  } else if (type === 'alarm') {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(520, now); o.frequency.linearRampToValueAtTime(780, now + 0.22);
    g.gain.setValueAtTime(0.1, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
    o.connect(g); g.connect(audioCtx.destination); o.start(now); o.stop(now + 0.35);
  } else if (type === 'obj') {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(880, now); o.frequency.setValueAtTime(1320, now + 0.09);
    g.gain.setValueAtTime(0.12, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    o.connect(g); g.connect(audioCtx.destination); o.start(now); o.stop(now + 0.25);
  }
}

// ===================== 3. SCENE, LIGHTING & REAL SKY =====================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16222e);
scene.fog = new THREE.FogExp2(0x16222e, 0.009);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = settings.shadowSize > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Realistic Cold Twilight Sky Dome
const skyGeo = new THREE.SphereGeometry(200, 16, 12);
const skyCanvas = document.createElement('canvas'); skyCanvas.width = 16; skyCanvas.height = 128;
const sctx = skyCanvas.getContext('2d');
const sg = sctx.createLinearGradient(0, 0, 0, 128);
sg.addColorStop(0, '#070e17'); sg.addColorStop(0.48, '#172838'); sg.addColorStop(0.62, '#2d4152'); sg.addColorStop(1, '#1a242e');
sctx.fillStyle = sg; sctx.fillRect(0, 0, 16, 128);
const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(skyCanvas), side: THREE.BackSide, fog: false }));
scene.add(skyMesh);

const hemiLight = new THREE.HemisphereLight(0x9ec0de, 0x263138, 0.85);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xd9ecff, 1.1);
sunLight.position.set(45, 65, 35);
sunLight.castShadow = settings.shadowSize > 0;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.near = 10; sunLight.shadow.camera.far = 180;
sunLight.shadow.camera.left = -65; sunLight.shadow.camera.right = 65;
sunLight.shadow.camera.top = 65; sunLight.shadow.camera.bottom = -65;
sunLight.shadow.bias = -0.0012;
scene.add(sunLight);

// ===================== 4. REAL ASSET LOADER (GLB + PHOTO TEXTURES) =====================
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

const LOADED_ASSETS = { soldier: null, weapon: null, truck: null, watchtower: null };
const ASSET_STATUS = { models: 0, textures: 0 };

function setLoadProgress(pct, msg) {
  document.getElementById('load-bar').style.width = `${pct}%`;
  document.getElementById('load-log').textContent = msg;
}

function loadOptionalGLB(path) {
  return new Promise(resolve => {
    gltfLoader.load(
      path,
      gltf => { ASSET_STATUS.models++; resolve(gltf); },
      undefined,
      () => resolve(null) // Gracefully fallback if user hasn't uploaded this .glb yet
    );
  });
}

function makeProceduralTex(drawFn, rx, ry) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  drawFn(c.getContext('2d'), 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function loadOptionalTexture(path, rx, ry, fallbackDraw) {
  return new Promise(resolve => {
    texLoader.load(
      path,
      tex => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(rx, ry);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        ASSET_STATUS.textures++;
        resolve(tex);
      },
      undefined,
      () => resolve(makeProceduralTex(fallbackDraw, rx, ry))
    );
  });
}

// ===================== 5. REAL 3D CARPATHIAN MOUNTAIN HEIGHTMAP =====================
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Flat inside the military compound (-42..42), rising into real snow mountains outside!
function getTerrainHeight(x, z) {
  const edgeDist = Math.max(Math.abs(x) - 42, Math.abs(z) - 44);
  if (edgeDist <= 0) return 0;
  const blend = smoothstep(0, 26, edgeDist);
  const hills =
    Math.sin(x * 0.055) * Math.cos(z * 0.055) * 9.5 +
    Math.sin(x * 0.13 + z * 0.09) * 3.2 +
    Math.abs(Math.cos(x * 0.03 - z * 0.04)) * 12.0;
  // Keep a walkable snowy infiltration hill on South spawn side (z > 44, |x| < 14)
  if (z > 42 && Math.abs(x) < 16) {
    return smoothstep(42, 72, z) * 6.5;
  }
  return Math.max(0, blend * (hills + edgeDist * 0.32));
}

// ===================== 6. WORLD, BUILDINGS, ENEMIES & WEAPON =====================
const colliders = [];
const worldMeshes = [];
const mapRects = [];
const enemies = [];
const hitMeshes = [];
const mats = {};

let empChipMesh = null, termScreenMesh = null, extractRingMesh = null, secCam = null;
const gunRoot = new THREE.Group();
camera.add(gunRoot);
const muzzleFlash = new THREE.Mesh(
  new THREE.SphereGeometry(0.05, 6, 6),
  new THREE.MeshBasicMaterial({ color: 0xffe484, transparent: true, opacity: 0 })
);

// Snowfall particles
const SNOW_MAX = 480;
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(SNOW_MAX * 3);
for (let i = 0; i < SNOW_MAX; i++) {
  snowPos[i * 3] = (Math.random() - 0.5) * 90;
  snowPos[i * 3 + 1] = Math.random() * 28;
  snowPos[i * 3 + 2] = (Math.random() - 0.5) * 90;
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowParticles = new THREE.Points(
  snowGeo, new THREE.PointsMaterial({ color: 0xdce8f2, size: 0.17, transparent: true, opacity: 0.72 })
);
scene.add(snowParticles);

function addBox(w, h, d, x, y, z, mat, solid = true, mapCol = null) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m); worldMeshes.push(m);
  if (solid) colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  if (mapCol) mapRects.push({ x, z, w, d, color: mapCol });
  return m;
}

function normalizeModel(obj, targetHeight) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); box.getSize(size);
  if (size.y > 0.001) {
    const scale = targetHeight / size.y;
    obj.scale.multiplyScalar(scale);
  }
  const box2 = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3(); box2.getCenter(center);
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box2.min.y;
  obj.traverse(c => {
    if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
  });
}

function setupWeapon() {
  if (LOADED_ASSETS.weapon) {
    const wp = LOADED_ASSETS.weapon.scene.clone();
    normalizeModel(wp, 0.24);
    wp.rotation.y = Math.PI; // Standard GLB facing forward
    gunRoot.add(wp);
    muzzleFlash.position.set(0, 0.05, -0.48);
  } else {
    // Detailed MP5SD3 PBR Fallback
    const gm = new THREE.MeshStandardMaterial({ color: 0x1e2429, roughness: 0.38, metalness: 0.78 });
    const gp = new THREE.MeshStandardMaterial({ color: 0x111518, roughness: 0.85, metalness: 0.15 });
    const rcv = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.084, 0.36), gm);
    const shrd = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.033, 0.22, 10), gp);
    shrd.rotation.x = Math.PI / 2; shrd.position.set(0, 0.01, -0.24);
    const brl = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.19, 10), gm);
    brl.rotation.x = Math.PI / 2; brl.position.set(0, 0.01, -0.41);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.033, 0.18, 0.044), gp);
    mag.position.set(0, -0.11, -0.07); mag.rotation.x = -0.18;
    gunRoot.add(rcv, shrd, brl, mag);
    muzzleFlash.position.set(0, 0.01, -0.52);
  }
  gunRoot.add(muzzleFlash);
  gunRoot.position.set(0.22, -0.22, -0.42);
}

function buildTerrainAndBase() {
  // 1. 3D Heightmap Mountain Terrain (Vertex colored Snow + Rocky Slopes)
  const segs = 96;
  const tGeo = new THREE.PlaneGeometry(240, 240, segs, segs);
  tGeo.rotateX(-Math.PI / 2);
  const pos = tGeo.attributes.position;
  const colors = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);
    // Darker slate rock on steeper/higher mountain ridges, snow elsewhere
    const rockMix = Math.min(1, Math.max(0, (y - 7) / 22));
    const r = 0.88 - rockMix * 0.48;
    const g = 0.91 - rockMix * 0.47;
    const b = 0.95 - rockMix * 0.44;
    colors.push(r, g, b);
  }
  tGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  tGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(tGeo, new THREE.MeshStandardMaterial({
    map: mats.snowTex, vertexColors: true, roughness: 0.92, metalness: 0.04
  }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  // Asphalt compound road
  const road = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 86), new THREE.MeshStandardMaterial({ color: 0x2a3136, roughness: 0.92 }));
  road.rotation.x = -Math.PI / 2; road.position.set(0, 0.04, 0); road.receiveShadow = true;
  scene.add(road);

  // Perimeter Concrete Wall + Gate Gap on South
  addBox(36, 2.5, 1, -24, 1.25, 42, mats.concrete, true, '#3a5444');
  addBox(36, 2.5, 1, 24, 1.25, 42, mats.concrete, true, '#3a5444');
  addBox(84, 2.5, 1, 0, 1.25, -44, mats.concrete, true, '#3a5444');
  addBox(1, 2.5, 86, -42, 1.25, -1, mats.concrete, true, '#3a5444');
  addBox(1, 2.5, 86, 42, 1.25, -1, mats.concrete, true, '#3a5444');

  // Walkable Main Warehouse (West — holds EMP Chips)
  addBox(1.1, 7.2, 22, -30, 3.6, -4, mats.metal, true, '#2d6a47');
  addBox(16, 7.2, 1.1, -22, 3.6, -15, mats.metal, true, '#2d6a47');
  addBox(16, 7.2, 1.1, -22, 3.6, 7, mats.metal, true, '#2d6a47');
  addBox(1.1, 7.2, 8.6, -14, 3.6, -10.7, mats.metal, true, '#2d6a47');
  addBox(1.1, 7.2, 8.6, -14, 3.6, 2.7, mats.metal, true, '#2d6a47');
  addBox(1.1, 2.5, 4.8, -14, 5.95, -4, mats.metal, false);
  addBox(17.2, 0.7, 23.2, -22, 7.5, -4, mats.roof, false);
  addBox(1.8, 1.0, 2.6, -26.8, 0.5, -4, mats.crate, true);

  // Walkable Control Bunker (East — holds Elevator Hack Terminal)
  addBox(1.1, 5.2, 14, 29, 2.6, -20, mats.concrete, true, '#357853');
  addBox(14, 5.2, 1.1, 22, 2.6, -27, mats.concrete, true, '#357853');
  addBox(14, 5.2, 1.1, 22, 2.6, -13, mats.concrete, true, '#357853');
  addBox(1.1, 5.2, 4.8, 15, 2.6, -24.6, mats.concrete, true, '#357853');
  addBox(1.1, 5.2, 4.8, 15, 2.6, -15.4, mats.concrete, true, '#357853');
  addBox(1.1, 1.8, 4.4, 15, 4.3, -20, mats.concrete, false);
  addBox(15.2, 0.7, 15.2, 22, 5.5, -20, mats.roof, false);

  // Mine Shaft Elevator House (North Extraction)
  addBox(8.6, 5.4, 1, 0, 2.7, -41, mats.concrete, true, '#4f7d5d');
  addBox(1, 5.4, 7.5, -4.3, 2.7, -37.2, mats.concrete, true, '#4f7d5d');
  addBox(1, 5.4, 7.5, 4.3, 2.7, -37.2, mats.concrete, true, '#4f7d5d');
  addBox(9.2, 0.7, 8.2, 0, 5.7, -37.2, mats.roof, false);

  // Watchtower (Uses Real watchtower.glb if uploaded!)
  if (LOADED_ASSETS.watchtower) {
    const wt = LOADED_ASSETS.watchtower.scene.clone();
    normalizeModel(wt, 12.5);
    wt.position.set(-34, 0, -34);
    scene.add(wt);
    colliders.push({ minX: -36.5, maxX: -31.5, minZ: -36.5, maxZ: -31.5 });
  } else {
    addBox(0.55, 9, 0.55, -36, 4.5, -36, mats.darkSteel, true);
    addBox(0.55, 9, 0.55, -32, 4.5, -36, mats.darkSteel, true);
    addBox(0.55, 9, 0.55, -36, 4.5, -32, mats.darkSteel, true);
    addBox(0.55, 9, 0.55, -32, 4.5, -32, mats.darkSteel, true);
    addBox(5.2, 0.5, 5.2, -34, 9.1, -34, mats.concrete, false, '#4e8a62');
    addBox(5.6, 0.4, 5.6, -34, 12.4, -34, mats.roof, false);
  }

  // Military Truck (Uses Real truck.glb if uploaded!)
  if (LOADED_ASSETS.truck) {
    const tr = LOADED_ASSETS.truck.scene.clone();
    normalizeModel(tr, 3.3);
    tr.position.set(11, 0, 12);
    tr.rotation.y = -0.35;
    scene.add(tr);
    colliders.push({ minX: 8.5, maxX: 13.5, minZ: 8, maxZ: 16 });
    mapRects.push({ x: 11, z: 12, w: 4, d: 7, color: '#5b6e42' });
  } else {
    addBox(2.4, 2.4, 2.4, 9, 1.2, 14, mats.crate, true, '#576b3d');
    addBox(2.4, 2.4, 2.4, 11.6, 1.2, 14, mats.crate, true, '#576b3d');
  }

  // Cover Crates
  [[-8, 16], [8, -4], [-8, -22], [8, -30]].forEach(([x, z]) => addBox(2.3, 2.3, 2.3, x, 1.15, z, mats.crate, true, '#576b3d'));

  // Instanced Snow Pine Trees around the Hills
  const treeSpots = [
    [-22, 52], [-14, 58], [16, 56], [26, 48], [-48, 22], [-48, -14], [48, 18], [48, -18], [-24, -50], [22, -50]
  ];
  const trunkI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.24, 0.36, 2.4, 6), new THREE.MeshLambertMaterial({ color: 0x3b2c20 }), treeSpots.length);
  const leafI = new THREE.InstancedMesh(new THREE.ConeGeometry(2.5, 7.2, 6), new THREE.MeshLambertMaterial({ color: 0x1d3428 }), treeSpots.length);
  const dObj = new THREE.Object3D();
  treeSpots.forEach(([x, z], i) => {
    const ty = getTerrainHeight(x, z);
    dObj.position.set(x, ty + 1.2, z); dObj.updateMatrix(); trunkI.setMatrixAt(i, dObj.matrix);
    dObj.position.set(x, ty + 5.2, z); dObj.updateMatrix(); leafI.setMatrixAt(i, dObj.matrix);
  });
  scene.add(trunkI, leafI);

  // Objectives Visuals
  empChipMesh = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.25, 0.45), new THREE.MeshBasicMaterial({ color: 0x38d9ff }));
  empChipMesh.position.set(-26.8, 1.15, -4); scene.add(empChipMesh);

  addBox(1.1, 2.2, 1.8, 27.5, 1.1, -20, mats.darkSteel, true);
  termScreenMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.65), new THREE.MeshBasicMaterial({ color: 0x35ff7a }));
  termScreenMesh.rotation.y = -Math.PI / 2; termScreenMesh.position.set(26.92, 1.45, -20); scene.add(termScreenMesh);

  extractRingMesh = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.35, 16), new THREE.MeshBasicMaterial({ color: 0xff5555, side: THREE.DoubleSide }));
  extractRingMesh.rotation.x = -Math.PI / 2; extractRingMesh.position.set(0, 0.08, -37.2); scene.add(extractRingMesh);

  // Security Camera
  const cGrp = new THREE.Group(); cGrp.position.set(-13.2, 5.2, 3.2);
  const cBody = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.34, 0.72), mats.darkSteel);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x3cff6a });
  const cLed = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), ledMat); cLed.position.set(0, 0, 0.38);
  const coneGeo = new THREE.ConeGeometry(4.0, 16, 10, 1, true); coneGeo.translate(0, -8, 0); coneGeo.rotateX(-Math.PI / 2);
  const coneMesh = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: 0x3cff6a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  coneMesh.rotation.x = 0.25;
  cGrp.add(cBody, cLed, coneMesh);
  cBody.userData = { isCamera: true };
  scene.add(cGrp); hitMeshes.push(cBody);
  secCam = { alive: true, pos: cGrp.position.clone(), angle: 0, dir: 1, group: cGrp, coneMesh, ledMat };
}

// ===================== 7. ANIMATED REAL 3D ENEMIES + FAST HITBOXES =====================
const ENEMY_CFGS = [
  { pts: [[-4, 24], [8, 24], [8, 12], [-4, 12]] },
  { pts: [[4, 4], [4, -12]] },
  { pts: [[-21, 3], [-21, -11]] },
  { pts: [[11, -14], [11, -26]] },
  { pts: [[21, -18], [24, -22]] },
  { pts: [[-9, -31], [9, -31]] },
  { pts: [[-34, -34]], y: 9.4 }
];
const invisibleHitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const thermalBodyMat = new THREE.MeshBasicMaterial({ color: 0xff8800 });

function spawnEnemies(saved = null) {
  enemies.forEach(e => scene.remove(e.group));
  enemies.length = 0;
  hitMeshes.length = 0;
  if (secCam) hitMeshes.push(secCam.group.children[0]);

  ENEMY_CFGS.forEach((cfg, idx) => {
    const g = new THREE.Group();
    const st = saved ? saved[idx] : null;
    const sx = st ? st.x : cfg.pts[0][0], sz = st ? st.z : cfg.pts[0][1];
    const sy = cfg.y !== undefined ? cfg.y : getTerrainHeight(sx, sz);
    g.position.set(sx, sy, sz);

    let mixer = null, actions = {}, visualMeshes = [], legL = null, legR = null;

    if (LOADED_ASSETS.soldier) {
      // REAL GLB ANIMATED SOLDIER (Cloned cleanly with SkeletonUtils)
      const model = cloneSkinned(LOADED_ASSETS.soldier.scene);
      normalizeModel(model, 1.82);
      g.add(model);
      model.traverse(c => {
        if (c.isMesh) { c.userData.origMat = c.material; visualMeshes.push(c); }
      });
      if (LOADED_ASSETS.soldier.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        const clips = LOADED_ASSETS.soldier.animations;
        const findClip = rx => clips.find(c => rx.test(c.name)) || clips[0];
        actions.idle = mixer.clipAction(findClip(/idle|stand/i));
        actions.walk = mixer.clipAction(findClip(/walk|run|move/i));
        actions.idle.play();
      }
    } else {
      // Tactical Fallback Soldier
      const bMat = new THREE.MeshStandardMaterial({ color: 0x2d3a33, roughness: 0.85 });
      const aMat = new THREE.MeshStandardMaterial({ color: 0x1b211f, roughness: 0.7 });
      const sMat = new THREE.MeshStandardMaterial({ color: 0xc29b7c, roughness: 0.8 });
      legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.85, 0.24), bMat); legL.position.set(-0.14, 0.42, 0);
      legR = legL.clone(); legR.position.x = 0.14;
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.7, 0.3), bMat); torso.position.y = 1.18;
      const vest = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.48, 0.34), aMat); vest.position.y = 1.22;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), sMat); head.position.y = 1.72;
      const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.88), mats.darkSteel); rifle.position.set(0.28, 1.18, 0.34);
      g.add(legL, legR, torso, vest, head, rifle);
      [legL, legR, torso, vest, head].forEach(m => { m.castShadow = true; m.userData.origMat = m.material; visualMeshes.push(m); });
    }

    // Ultra-Fast Invisible Hitboxes (Crucial Mobile FPS Optimization — avoids raycasting high-poly GLB meshes!)
    const bodyHit = new THREE.Mesh(new THREE.BoxGeometry(0.65, 1.4, 0.45), invisibleHitMat); bodyHit.position.y = 0.72;
    const headHit = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.36), invisibleHitMat); headHit.position.y = 1.66;
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 5, 5), new THREE.MeshBasicMaterial({ color: 0xffb74d, transparent: true, opacity: 0 }));
    muzzle.position.set(0.28, 1.22, 0.82);
    g.add(bodyHit, headHit, muzzle);

    const eObj = {
      group: g, mixer, actions, curAnim: 'idle', visualMeshes, legL, legR, muzzle,
      pts: cfg.pts, wp: 0, fixedY: cfg.y,
      hp: st ? st.hp : 100, alive: st ? st.alive : true,
      alert: false, fireCd: 0.8 + Math.random() * 0.5,
      aiAccum: Math.random() * 0.25, walkPhase: Math.random() * 6
    };
    bodyHit.userData = { enemy: eObj, isHead: false };
    headHit.userData = { enemy: eObj, isHead: true };
    hitMeshes.push(bodyHit, headHit);

    if (!eObj.alive) { g.rotation.x = -Math.PI / 2; g.position.y = sy + 0.2; }
    scene.add(g);
    enemies.push(eObj);
  });
}

// ===================== 8. PLAYER, OBJECTIVES & CONTROLS =====================
const player = {
  x: 0, y: 1.7, z: 58, yaw: 0, pitch: -0.1, hp: 100,
  ammo: 30, reserve: 120, reloading: false,
  crouching: false, scoping: false, thermal: false, recoil: 0, speed: 7.4
};
let mState = { gotChips: false, hacked: false, alarm: false, alarmTimer: 0, savesLeft: 3 };
let gameActive = false, paused = false, isFiring = false, fireTimer = 0;

function setThermal(on) {
  player.thermal = on;
  document.getElementById('thermal-overlay').style.display = on ? 'block' : 'none';
  document.getElementById('btn-therm').classList.toggle('active', on);
  scene.fog.color.setHex(on ? 0x050b1f : 0x16222e);
  enemies.forEach(e => e.visualMeshes.forEach(m => { m.material = (on && e.alive) ? thermalBodyMat : m.userData.origMat; }));
}

function setScope(on) {
  player.scoping = on;
  camera.fov = on ? 26 : 68; camera.updateProjectionMatrix();
  gunRoot.visible = !on;
  document.getElementById('scope-overlay').style.display = on ? 'block' : 'none';
  document.getElementById('crosshair').style.display = on ? 'none' : 'block';
  document.getElementById('btn-scope').classList.toggle('active', on);
}

function syncVisuals() {
  if (empChipMesh) empChipMesh.visible = !mState.gotChips;
  if (termScreenMesh) termScreenMesh.material.color.setHex(mState.hacked ? 0xffd166 : 0x35ff7a);
  if (extractRingMesh) extractRingMesh.material.color.setHex(mState.hacked ? 0x52ff7f : 0xff5555);
}

function startMission(saved = null) {
  initAudio();
  if (saved) {
    Object.assign(player, { x: saved.px, y: saved.py, z: saved.pz, yaw: saved.yaw, pitch: saved.pitch, hp: saved.hp, ammo: saved.ammo, reserve: saved.reserve, reloading: false, crouching: false });
    mState = { gotChips: saved.gotChips, hacked: saved.hacked, alarm: false, alarmTimer: 0, savesLeft: saved.savesLeft };
    spawnEnemies(saved.enemies);
    if (secCam) { secCam.alive = saved.camAlive; secCam.coneMesh.visible = saved.camAlive; }
  } else {
    player.x = 0; player.z = 58; player.y = getTerrainHeight(0, 58) + 1.7;
    player.yaw = 0; player.pitch = -0.12; player.hp = 100; player.ammo = 30; player.reserve = 120;
    player.reloading = false; player.crouching = false;
    mState = { gotChips: false, hacked: false, alarm: false, alarmTimer: 0, savesLeft: 3 };
    spawnEnemies(null);
    if (secCam) { secCam.alive = true; secCam.coneMesh.visible = true; secCam.ledMat.color.setHex(0x3cff6a); }
  }
  setScope(false); setThermal(false); syncVisuals(); updateHUD();
  gameActive = true; paused = false;
  ['start-screen', 'settings-modal', 'map-modal', 'end-modal'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('hud').style.display = 'block';
  document.getElementById('btn-restart-mission').style.display = 'inline-block';
  showBanner(saved ? 'CHECKPOINT RESTORED' : 'INFILTRATE BASE & RETRIEVE EMP CHIPS', '#7CFF9B');
}

function saveMission() {
  if (mState.savesLeft <= 0) return;
  mState.savesLeft--;
  const data = {
    px: player.x, py: player.y, pz: player.z, yaw: player.yaw, pitch: player.pitch,
    hp: player.hp, ammo: player.ammo, reserve: player.reserve,
    gotChips: mState.gotChips, hacked: mState.hacked, savesLeft: mState.savesLeft,
    camAlive: secCam ? secCam.alive : false,
    enemies: enemies.map(e => ({ x: e.group.position.x, z: e.group.position.z, hp: e.hp, alive: e.alive })),
    time: new Date().toLocaleTimeString()
  };
  setStore(SAVE_KEY, data);
  document.getElementById('save-feedback').textContent = `SAVED TO IGI SATELLITE (${data.time})`;
  updateSaveUI();
}

function updateSaveUI() {
  const sv = getStore(SAVE_KEY);
  document.getElementById('btn-continue').style.display = sv ? 'inline-block' : 'none';
  document.getElementById('btn-load-last-save').style.display = sv ? 'inline-block' : 'none';
  document.getElementById('save-status-home').textContent = sv ? `SAVED CHECKPOINT: ${sv.time} (HP ${sv.hp}%)` : '';
  const sb = document.getElementById('btn-save-mission');
  sb.textContent = `UPLOAD SAVE (${mState.savesLeft} LEFT)`; sb.disabled = mState.savesLeft <= 0;
}

let bT = null, hT = null;
function showBanner(msg, col = '#7CFF9B') {
  const el = document.getElementById('status-banner');
  el.textContent = msg; el.style.color = col; el.style.opacity = '1';
  clearTimeout(bT); bT = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

function getObjText() {
  if (!mState.gotChips) return 'GET EMP CHIPS (WEST WAREHOUSE)';
  if (!mState.hacked) return 'HACK BUNKER TERMINAL (EAST)';
  return 'EXTRACT AT MINE ELEVATOR (NORTH)';
}

function updateHUD() {
  document.getElementById('hud-obj').textContent = getObjText();
  document.getElementById('hp-bar').style.width = `${Math.max(0, player.hp)}%`;
  document.getElementById('hp-bar').style.background = player.hp > 40 ? '#52ff7f' : '#ff4d4d';
  document.getElementById('ammo-val').textContent = player.reloading ? 'RELOADING...' : `${player.ammo} / ${player.reserve}`;
  document.getElementById('stance-val').textContent = player.crouching ? 'CROUCH' : 'STAND';
  document.getElementById('enemy-count').textContent = enemies.filter(e => e.alive).length;
  document.getElementById('alarm-tag').style.display = mState.alarm ? 'block' : 'none';
  updateSaveUI();
}

// ===================== 9. GRAPHICS PRESETS & OPTIMIZATION =====================
const PRESETS = {
  potato: { preset: 'potato', resScale: 0.5, shadowSize: 0, snow: false, drawDist: 65 },
  low:    { preset: 'low',    resScale: 0.75, shadowSize: 512, snow: false, drawDist: 120 },
  med:    { preset: 'med',    resScale: 1.0, shadowSize: 1024, snow: true, drawDist: 120 },
  high:   { preset: 'high',   resScale: 1.25, shadowSize: 2048, snow: true, drawDist: 190 }
};

function applySettings() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.0);
  renderer.setPixelRatio(Math.max(0.45, Math.min(dpr * settings.resScale, 1.5)));
  const shOn = settings.shadowSize > 0;
  renderer.shadowMap.enabled = shOn;
  sunLight.castShadow = shOn;
  if (shOn && sunLight.shadow.mapSize.width !== settings.shadowSize) {
    sunLight.shadow.mapSize.set(settings.shadowSize, settings.shadowSize);
    if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
  }
  snowParticles.visible = settings.snow;
  camera.far = settings.drawDist + 60; camera.updateProjectionMatrix();
  scene.fog.density = settings.drawDist < 80 ? 0.016 : (settings.drawDist < 140 ? 0.009 : 0.0055);

  document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('selected', b.dataset.preset === settings.preset));
  document.querySelectorAll('.res-btn').forEach(b => b.classList.toggle('selected', parseFloat(b.dataset.res) === settings.resScale));
  document.querySelectorAll('.shd-btn').forEach(b => b.classList.toggle('selected', parseInt(b.dataset.shd) === settings.shadowSize));
  document.querySelectorAll('.dist-btn').forEach(b => b.classList.toggle('selected', parseInt(b.dataset.dist) === settings.drawDist));
  document.querySelectorAll('.sens-btn').forEach(b => b.classList.toggle('selected', parseFloat(b.dataset.sens) === settings.sens));
  const sn = document.getElementById('tog-snow'); sn.textContent = settings.snow ? 'ON' : 'OFF'; sn.classList.toggle('selected', settings.snow);
  setStore(CFG_KEY, settings);
}

// ===================== 10. SHOOTING, INTERACT & INPUTS =====================
const raycaster = new THREE.Raycaster();
function fireOnce() {
  if (!gameActive || paused || player.reloading) return;
  initAudio();
  if (player.ammo <= 0) return reloadGun();
  player.ammo--; fireTimer = 0.11; player.recoil = 0.055;
  playSfx('mp5');
  muzzleFlash.material.opacity = 0.85; setTimeout(() => { muzzleFlash.material.opacity = 0; }, 35);
  updateHUD();

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObjects([...hitMeshes, ...worldMeshes], false);
  if (hits.length > 0) {
    const obj = hits[0].object;
    if (obj.userData.isCamera && secCam && secCam.alive) {
      secCam.alive = false; secCam.coneMesh.visible = false; secCam.ledMat.color.setHex(0x222222);
      playSfx('head'); showBanner('SECURITY CAMERA DISABLED!', '#38d9ff'); return;
    }
    if (obj.userData.enemy && obj.userData.enemy.alive) {
      const en = obj.userData.enemy, isH = obj.userData.isHead;
      en.hp -= isH ? 100 : 38; en.alert = true;
      playSfx(isH ? 'head' : 'hit');
      const hm = document.getElementById('hitmarker');
      hm.style.color = isH ? '#ffd166' : '#ff4d4d'; hm.style.opacity = '1';
      clearTimeout(hT); hT = setTimeout(() => { hm.style.opacity = '0'; }, 120);
      if (en.hp <= 0) {
        en.alive = false; en.group.rotation.x = -Math.PI / 2; en.group.position.y += 0.2;
        if (en.mixer) en.mixer.stopAllAction();
        if (player.thermal) en.visualMeshes.forEach(m => { m.material = m.userData.origMat; });
        updateHUD(); showBanner(isH ? 'SILENT HEADSHOT' : 'HOSTILE DOWN', isH ? '#ffd166' : '#7CFF9B');
      }
    }
  }
}

function reloadGun() {
  if (player.reloading || player.ammo === 30 || player.reserve <= 0) return;
  player.reloading = true; updateHUD();
  setTimeout(() => {
    const t = Math.min(30 - player.ammo, player.reserve);
    player.ammo += t; player.reserve -= t; player.reloading = false; updateHUD();
  }, 900);
}

function interact() {
  if (!mState.gotChips && Math.hypot(player.x + 26.8, player.z + 4) < 3.6) {
    mState.gotChips = true; playSfx('obj'); syncVisuals(); updateHUD();
    showBanner('EMP CHIPS ACQUIRED! HACK BUNKER TERMINAL', '#ffd166');
  } else if (mState.gotChips && !mState.hacked && Math.hypot(player.x - 26.5, player.z + 20) < 3.6) {
    mState.hacked = true; playSfx('obj'); syncVisuals(); updateHUD();
    showBanner('MINE ELEVATOR UNLOCKED! PROCEED NORTH', '#52ff7f');
  }
}

function drawMap() {
  const c = document.getElementById('map-canvas'), ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.fillStyle = '#04120a'; ctx.fillRect(0, 0, w, h);
  const toX = wx => w / 2 + (wx / 60) * (w * 0.44);
  const toY = wz => h / 2 + (wz / 60) * (h * 0.44);
  mapRects.forEach(r => { ctx.fillStyle = r.color; ctx.fillRect(toX(r.x - r.w / 2), toY(r.z - r.d / 2), (r.w / 60) * (w * 0.44), (r.d / 60) * (h * 0.44)); });
  const ob = !mState.gotChips ? { x: -26.8, z: -4 } : (!mState.hacked ? { x: 26.5, z: -20 } : { x: 0, z: -37.2 });
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(toX(ob.x), toY(ob.z), 7, 0, Math.PI * 2); ctx.stroke();
  enemies.forEach(e => { if (e.alive) { ctx.fillStyle = e.alert ? '#ff3b3b' : '#ff9f43'; ctx.beginPath(); ctx.arc(toX(e.group.position.x), toY(e.group.position.z), 4, 0, Math.PI * 2); ctx.fill(); } });
  ctx.fillStyle = '#7CFF9B'; ctx.beginPath(); ctx.arc(toX(player.x), toY(player.z), 5, 0, Math.PI * 2); ctx.fill();
  document.getElementById('map-obj-text').innerHTML = `<b>TARGET (YELLOW):</b> ${getObjText()}`;
}

// Input Listeners
const keys = {}; let joyX = 0, joyY = 0;
window.addEventListener('keydown', e => {
  keys[e.code] = true; if (!gameActive) return;
  if (e.code === 'KeyM') toggleMap();
  if (paused) return;
  if (e.code === 'KeyC') { player.crouching = !player.crouching; document.getElementById('btn-crouch').classList.toggle('active', player.crouching); updateHUD(); }
  if (e.code === 'KeyR') reloadGun();
  if (e.code === 'KeyE') interact();
  if (e.code === 'KeyT') setThermal(!player.thermal);
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
renderer.domElement.addEventListener('click', () => { if (gameActive && !paused && document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.(); });
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement === renderer.domElement && gameActive && !paused) {
    const zm = player.scoping ? 0.35 : 1.0;
    player.yaw -= e.movementX * 0.0021 * settings.sens * zm;
    player.pitch = Math.max(-1.38, Math.min(1.38, player.pitch - e.movementY * 0.0021 * settings.sens * zm));
  }
});
window.addEventListener('mousedown', e => { if (document.pointerLockElement !== renderer.domElement || paused) return; if (e.button === 0) { isFiring = true; if (fireTimer <= 0) fireOnce(); } if (e.button === 2) setScope(!player.scoping); });
window.addEventListener('mouseup', e => { if (e.button === 0) isFiring = false; });
window.addEventListener('contextmenu', e => e.preventDefault());

// Touch Joystick & Aim
const joyZone = document.getElementById('joy-zone'), joyKnob = document.getElementById('joy-knob');
let joyId = null, lookId = null, lx = 0, ly = 0;
const moveJoy = t => {
  const r = joyZone.getBoundingClientRect(), m = r.width * 0.34;
  let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy);
  if (d > m) { dx = dx / d * m; dy = dy / d * m; }
  joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  joyX = dx / m; joyY = dy / m;
};
joyZone.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); if (joyId === null) { joyId = e.changedTouches[0].identifier; moveJoy(e.changedTouches[0]); } }, { passive: false });
joyZone.addEventListener('touchmove', e => { e.preventDefault(); e.stopPropagation(); for (const t of e.changedTouches) if (t.identifier === joyId) moveJoy(t); }, { passive: false });
const endJoy = e => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; joyX = 0; joyY = 0; joyKnob.style.transform = 'translate(-50%, -50%)'; } };
joyZone.addEventListener('touchend', endJoy); joyZone.addEventListener('touchcancel', endJoy);

renderer.domElement.addEventListener('touchstart', e => { if (!gameActive || paused) return; for (const t of e.changedTouches) if (lookId === null && t.identifier !== joyId) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; break; } }, { passive: true });
renderer.domElement.addEventListener('touchmove', e => {
  if (!gameActive || paused) return;
  for (const t of e.changedTouches) if (t.identifier === lookId) {
    const zm = player.scoping ? 0.35 : 1.0;
    player.yaw -= (t.clientX - lx) * 0.0052 * settings.sens * zm;
    player.pitch = Math.max(-1.38, Math.min(1.38, player.pitch - (t.clientY - ly) * 0.0052 * settings.sens * zm));
    lx = t.clientX; ly = t.clientY;
  }
}, { passive: true });
const endLook = e => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
renderer.domElement.addEventListener('touchend', endLook); renderer.domElement.addEventListener('touchcancel', endLook);

// Buttons
const fireB = document.getElementById('btn-fire');
fireB.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); isFiring = true; if (fireTimer <= 0) fireOnce(); }, { passive: false });
fireB.addEventListener('touchend', () => { isFiring = false; }); fireB.addEventListener('touchcancel', () => { isFiring = false; });
fireB.addEventListener('mousedown', e => { e.stopPropagation(); isFiring = true; if (fireTimer <= 0) fireOnce(); });
fireB.addEventListener('mouseup', () => { isFiring = false; });

const tap = (id, fn) => {
  const el = document.getElementById(id);
  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
  el.addEventListener('click', e => { e.stopPropagation(); fn(); });
};
tap('btn-crouch', () => { player.crouching = !player.crouching; document.getElementById('btn-crouch').classList.toggle('active', player.crouching); updateHUD(); });
tap('btn-scope', () => setScope(!player.scoping));
tap('btn-therm', () => setThermal(!player.thermal));
tap('btn-reload', reloadGun);
tap('btn-interact', interact);

function toggleMap() {
  const m = document.getElementById('map-modal'), open = m.style.display !== 'flex';
  m.style.display = open ? 'flex' : 'none'; paused = open; isFiring = false;
  if (open) { document.exitPointerLock?.(); document.getElementById('save-feedback').textContent = ''; updateSaveUI(); drawMap(); }
}
const openSet = () => { paused = true; isFiring = false; document.exitPointerLock?.(); document.getElementById('settings-modal').style.display = 'flex'; applySettings(); };

document.getElementById('btn-deploy').onclick = () => startMission(null);
document.getElementById('btn-continue').onclick = () => startMission(getStore(SAVE_KEY));
document.getElementById('btn-open-settings').onclick = openSet;
document.getElementById('btn-menu').onclick = openSet;
document.getElementById('btn-map').onclick = toggleMap;
document.getElementById('btn-close-map').onclick = toggleMap;
document.getElementById('btn-save-mission').onclick = saveMission;
document.getElementById('btn-close-settings').onclick = () => { document.getElementById('settings-modal').style.display = 'none'; paused = false; };
document.getElementById('btn-restart-mission').onclick = () => startMission(null);
document.getElementById('btn-end-restart').onclick = () => startMission(null);
document.getElementById('btn-load-last-save').onclick = () => startMission(getStore(SAVE_KEY));
document.getElementById('btn-full').onclick = () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); else document.exitFullscreen?.().catch(() => {}); };

document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { Object.assign(settings, PRESETS[b.dataset.preset]); applySettings(); });
document.querySelectorAll('.res-btn').forEach(b => b.onclick = () => { settings.resScale = parseFloat(b.dataset.res); settings.preset = 'custom'; applySettings(); });
document.querySelectorAll('.shd-btn').forEach(b => b.onclick = () => { settings.shadowSize = parseInt(b.dataset.shd); settings.preset = 'custom'; applySettings(); });
document.querySelectorAll('.dist-btn').forEach(b => b.onclick = () => { settings.drawDist = parseInt(b.dataset.dist); settings.preset = 'custom'; applySettings(); });
document.querySelectorAll('.sens-btn').forEach(b => b.onclick = () => { settings.sens = parseFloat(b.dataset.sens); applySettings(); });
document.getElementById('tog-snow').onclick = () => { settings.snow = !settings.snow; settings.preset = 'custom'; applySettings(); };

// ===================== 11. COLLISION, AI THROTTLING & LOOP =====================
function collides(nx, nz) {
  if (nx < -65 || nx > 65 || nz < -58 || nz > 68) return true;
  const r = 0.6;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (nx + r > c.minX && nx - r < c.maxX && nz + r > c.minZ && nz - r < c.maxZ) return true;
  }
  return false;
}
const aiRay = new THREE.Raycaster();
function hasLOS(a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  aiRay.set(a, dir.clone().normalize()); aiRay.far = dir.length();
  return aiRay.intersectObjects(worldMeshes, false).length === 0;
}

function endGame(win, title, desc) {
  gameActive = false; paused = true; isFiring = false; setScope(false); setThermal(false); document.exitPointerLock?.();
  document.getElementById('end-title').textContent = title;
  document.getElementById('end-title').style.color = win ? '#7CFF9B' : '#ff6b6b';
  document.getElementById('end-desc').textContent = desc;
  document.getElementById('end-modal').style.display = 'flex'; updateSaveUI();
}

let lastT = performance.now(), frames = 0, fpsT = lastT, alarmBeep = 0;
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastT) / 1000, 0.05); lastT = now;

  frames++;
  if (now - fpsT >= 500) {
    document.getElementById('fps-val').textContent = Math.round((frames * 1000) / (now - fpsT));
    frames = 0; fpsT = now;
  }

  if (settings.snow) {
    const arr = snowGeo.attributes.position.array;
    for (let i = 0; i < SNOW_MAX; i++) {
      arr[i * 3 + 1] -= dt * 4.5;
      if (arr[i * 3 + 1] < 0) {
        arr[i * 3] = player.x + (Math.random() - 0.5) * 65; arr[i * 3 + 1] = player.y + 18;
        arr[i * 3 + 2] = player.z + (Math.random() - 0.5) * 65;
      }
    }
    snowGeo.attributes.position.needsUpdate = true;
  }

  if (gameActive && !paused) {
    if (fireTimer > 0) fireTimer -= dt;
    if (isFiring && fireTimer <= 0) fireOnce();

    let fwd = -joyY, str = joyX;
    if (keys['KeyW'] || keys['ArrowUp']) fwd += 1;
    if (keys['KeyS'] || keys['ArrowDown']) fwd -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) str += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) str -= 1;
    const mag = Math.hypot(fwd, str); if (mag > 1) { fwd /= mag; str /= mag; }

    const spd = player.crouching ? player.speed * 0.48 : (player.scoping ? player.speed * 0.55 : player.speed);
    const sY = Math.sin(player.yaw), cY = Math.cos(player.yaw);
    const dx = (-sY * fwd + cY * str) * spd * dt, dz = (-cY * fwd - sY * str) * spd * dt;
    if (!collides(player.x + dx, player.z)) player.x += dx;
    if (!collides(player.x, player.z + dz)) player.z += dz;

    const groundY = getTerrainHeight(player.x, player.z);
    player.y += (groundY + (player.crouching ? 1.02 : 1.7) - player.y) * Math.min(1, dt * 12);
    camera.position.set(player.x, player.y, player.z);
    camera.rotation.y = player.yaw; camera.rotation.x = player.pitch;

    player.recoil *= Math.max(0, 1 - dt * 15);
    const bob = mag > 0.1 ? Math.sin(now * 0.011) * 0.008 : 0;
    gunRoot.position.set(0.22, -0.22 + bob + player.recoil * 0.2, -0.42 + player.recoil);
    gunRoot.rotation.x = player.recoil * 2.0;

    // Interact & Extraction
    const iBtn = document.getElementById('btn-interact');
    if (!mState.gotChips && Math.hypot(player.x + 26.8, player.z + 4) < 3.6) { iBtn.textContent = '[E] RETRIEVE EMP CHIPS'; iBtn.style.display = 'block'; }
    else if (mState.gotChips && !mState.hacked && Math.hypot(player.x - 26.5, player.z + 20) < 3.6) { iBtn.textContent = '[E] HACK ELEVATOR LOCK'; iBtn.style.display = 'block'; }
    else iBtn.style.display = 'none';

    if (mState.hacked && Math.hypot(player.x, player.z + 37.2) < 3.2) {
      playSfx('obj'); endGame(true, 'MISSION 01 ACCOMPLISHED!', 'EMP Chips secured. Entering the Mine Shaft...');
    }

    // Security Camera
    if (secCam && secCam.alive) {
      secCam.angle += secCam.dir * dt * 0.55; if (Math.abs(secCam.angle) > 0.85) secCam.dir *= -1;
      secCam.group.rotation.y = Math.PI * 0.32 + secCam.angle;
      const toP = new THREE.Vector3().subVectors(camera.position, secCam.pos);
      if (toP.length() < 18) {
        const fwdC = new THREE.Vector3(0, 0, 1).applyQuaternion(secCam.group.quaternion);
        if (fwdC.dot(toP.clone().normalize()) > 0.88 && hasLOS(secCam.pos, camera.position)) {
          secCam.ledMat.color.setHex(0xff2a2a);
          if (!mState.alarm) {
            mState.alarm = true; mState.alarmTimer = 14; playSfx('alarm');
            enemies.forEach(e => { if (e.alive) e.alert = true; });
            showBanner('CAMERA DETECTED YOU! ALARM ACTIVE!', '#ff5c5c'); updateHUD();
          }
        }
      }
    }
    if (mState.alarm) {
      mState.alarmTimer -= dt; alarmBeep += dt;
      if (alarmBeep > 1.8) { playSfx('alarm'); alarmBeep = 0; }
      if (mState.alarmTimer <= 0) { mState.alarm = false; document.getElementById('alarm-tag').style.display = 'none'; }
    }

    // OPTIMIZED ENEMY LOOP (AI Throttling + Animation Distance Culling)
    const detRange = player.crouching ? 16 : 26;
    const pEye = camera.position;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]; if (!e.alive) continue;
      const ex = e.group.position.x, ez = e.group.position.z;
      const distP = Math.hypot(player.x - ex, player.z - ez);

      // LOD Visibility & Animation Culling (Prevents lag when many guards are in base)
      const visible = distP < settings.drawDist + 10;
      e.group.visible = visible;
      if (visible && e.mixer && distP < settings.drawDist * 0.85) e.mixer.update(dt);

      // AI Throttling: Far enemies check LOS only 4 times/sec
      e.aiAccum += dt;
      const interval = distP > 30 ? 0.25 : 0.08;
      if (!e.alert && distP < detRange && e.aiAccum >= interval) {
        e.aiAccum = 0;
        if (hasLOS(new THREE.Vector3(ex, e.group.position.y + 1.65, ez), pEye)) {
          e.alert = true; showBanner('GUARD SPOTTED YOU!', '#ff8c42');
        }
      }

      if (e.alert) {
        e.group.rotation.y = Math.atan2(player.x - ex, player.z - ez);
        if (e.mixer && e.curAnim !== 'idle' && e.actions.idle) { e.actions.walk?.stop(); e.actions.idle.play(); e.curAnim = 'idle'; }
        e.fireCd -= dt;
        if (e.fireCd <= 0 && distP < 36 && hasLOS(new THREE.Vector3(ex, e.group.position.y + 1.65, ez), pEye)) {
          e.fireCd = 0.95 + Math.random() * 0.5; playSfx('enemy');
          e.muzzle.material.opacity = 1; setTimeout(() => { e.muzzle.material.opacity = 0; }, 55);
          if (Math.random() < Math.max(0.16, (player.crouching ? 0.4 : 0.62) - distP * 0.012)) {
            player.hp -= 10;
            const fl = document.getElementById('damage-flash'); fl.style.opacity = '1'; setTimeout(() => { fl.style.opacity = '0'; }, 130);
            updateHUD();
            if (player.hp <= 0) endGame(false, 'MISSION FAILED', 'Agent Jones was eliminated.');
          }
        }
      } else if (e.pts.length > 1) {
        const wp = e.pts[e.wp], tx = wp[0] - ex, tz = wp[1] - ez, dW = Math.hypot(tx, tz);
        if (dW < 0.4) e.wp = (e.wp + 1) % e.pts.length;
        else {
          const st = 2.1 * dt;
          e.group.position.x += (tx / dW) * st; e.group.position.z += (tz / dW) * st;
          if (e.fixedY === undefined) e.group.position.y = getTerrainHeight(e.group.position.x, e.group.position.z);
          e.group.rotation.y = Math.atan2(tx, tz);
          if (e.mixer && e.curAnim !== 'walk' && e.actions.walk) { e.actions.idle?.stop(); e.actions.walk.play(); e.curAnim = 'walk'; }
          if (e.legL) { e.walkPhase += dt * 7; e.legL.rotation.x = Math.sin(e.walkPhase) * 0.45; e.legR.rotation.x = -Math.sin(e.walkPhase) * 0.45; }
        }
      }
    }
  }

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===================== 12. ASYNC ASSET BOOTSTRAP =====================
async function boot() {
  setLoadProgress(15, 'Loading Photo PBR Textures...');
  const snowTex = await loadOptionalTexture('./assets/textures/snow.jpg', 28, 28, (ctx, s) => {
    ctx.fillStyle = '#bcc8d1'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 3600; i++) { ctx.fillStyle = Math.random() < 0.25 ? 'rgba(72,82,88,0.22)' : 'rgba(235,242,248,0.38)'; ctx.fillRect(Math.random()*s, Math.random()*s, 4, 4); }
  });
  const concTex = await loadOptionalTexture('./assets/textures/concrete.jpg', 3, 2, (ctx, s) => {
    ctx.fillStyle = '#5c6468'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2800; i++) { const v = 65 + Math.floor(Math.random()*48); ctx.fillStyle = `rgba(${v},${v+2},${v+4},0.32)`; ctx.fillRect(Math.random()*s, Math.random()*s, 3, 3); }
    ctx.strokeStyle = 'rgba(20,24,28,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(2, 2, s-4, s/2-2); ctx.strokeRect(2, s/2, s-4, s/2-2);
  });
  const metTex = await loadOptionalTexture('./assets/textures/metal.jpg', 4, 2, (ctx, s) => {
    ctx.fillStyle = '#3a474c'; ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 12) { ctx.fillStyle = 'rgba(0,0,0,0.32)'; ctx.fillRect(x, 0, 4, s); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x+4, 0, 3, s); }
    for (let i = 0; i < 42; i++) { ctx.fillStyle = `rgba(120,56,28,${0.12+Math.random()*0.2})`; ctx.fillRect(Math.random()*s, Math.random()*s, 18, 22); }
  });
  const crateTex = makeProceduralTex((ctx, s) => {
    ctx.fillStyle = '#4f553b'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#2a2e1f'; ctx.lineWidth = 14; ctx.strokeRect(7, 7, s-14, s-14);
    ctx.fillStyle = 'rgba(220,205,120,0.6)'; ctx.font = 'bold 26px monospace'; ctx.fillText('RU-EMP', 68, 138);
  }, 1, 1);

  mats.snowTex = snowTex;
  mats.concrete = new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.9, metalness: 0.05 });
  mats.metal = new THREE.MeshStandardMaterial({ map: metTex, roughness: 0.65, metalness: 0.45 });
  mats.crate = new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.85 });
  mats.darkSteel = new THREE.MeshStandardMaterial({ color: 0x262d33, roughness: 0.5, metalness: 0.65 });
  mats.roof = new THREE.MeshStandardMaterial({ color: 0x1d242a, roughness: 0.85 });

  setLoadProgress(45, 'Loading 3D Soldier Model (assets/models/soldier.glb)...');
  LOADED_ASSETS.soldier = await loadOptionalGLB('./assets/models/soldier.glb');

  setLoadProgress(65, 'Loading 3D Weapon Model (assets/models/weapon.glb)...');
  LOADED_ASSETS.weapon = await loadOptionalGLB('./assets/models/weapon.glb');

  setLoadProgress(80, 'Loading Military Props (watchtower.glb / truck.glb)...');
  LOADED_ASSETS.watchtower = await loadOptionalGLB('./assets/models/watchtower.glb');
  LOADED_ASSETS.truck = await loadOptionalGLB('./assets/models/truck.glb');

  setLoadProgress(95, 'Building Carpathian Mountains & Military Base...');
  setupWeapon();
  buildTerrainAndBase();
  applySettings();
  updateSaveUI();

  document.getElementById('asset-badge').innerHTML =
    `REAL 3D MODELS LOADED: <b>${ASSET_STATUS.models} / 4</b> &nbsp;|&nbsp; REAL PHOTO TEXTURES: <b>${ASSET_STATUS.textures} / 3</b>` +
    (ASSET_STATUS.models === 0 ? '<br><span style="color:#ffd166;">Upload .glb models into assets/models/ for Full Real Graphics!</span>' : '');

  setLoadProgress(100, 'Ready.');
  setTimeout(() => {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('start-screen').style.display = 'flex';
  }, 350);

  animate(performance.now());
}

boot();
