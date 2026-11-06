// mapedit live viewer: overview LOD + detailed chunks near the camera,
// updated in real time from websocket edit events.
import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const SKY = new THREE.Color(dark ? 0x1b2130 : 0xbcd4ee);

// ------------------------------------------------------------------ three setup
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
$('view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 800, 6000);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 20000);
camera.position.set(0, 900, 1200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.495;
controls.screenSpacePanning = false;
const ambient = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.25);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

const chunkMat = new THREE.MeshBasicMaterial({ vertexColors: true });
const waterMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.78, depthWrite: false });
const overviewMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 6 });
const borderMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ state
let state = { worlds: [], current: 0, history: { entries: [], redo: 0 }, calls: 0 };
let worldName = null;
let world = null; // current world descriptor
let overview = null; // {x0,z0,nx,nz,step,h:Int16Array, mesh}
let borders = null;
const chunks = new Map(); // key "cx,cz" -> {group, stale, loading}
let queue = [];
let inflight = 0;
const labels = [];
let pulses = [];

function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = 'none'), ms);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r;
}

async function callTool(tool, args = {}) {
  const r = await api('/api/tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
  return r.json();
}

// ------------------------------------------------------------------ state/UI
async function loadState() {
  state = await (await api('/api/state')).json();
  $('empty').style.display = state.worlds.length ? 'none' : 'flex';
  $('mcpUrl').textContent = `${location.origin}/mcp`;
  const names = state.worlds.map((w) => w.name);
  if (!worldName || !names.includes(worldName)) {
    worldName = state.worlds[state.current]?.name ?? null;
    if (worldName) switchWorld(worldName);
  } else {
    world = state.worlds.find((w) => w.name === worldName);
    buildBorders();
    buildLabels();
  }
  renderWorldTabs();
  renderChips();
  renderLog();
}

function dimLabel(d) {
  return { overworld: '主世界', the_nether: '下界', the_end: '末地' }[d] || d;
}

function renderWorldTabs() {
  const el = $('worlds');
  el.innerHTML = '';
  for (const w of state.worlds) {
    const b = document.createElement('button');
    b.textContent = state.worlds.length > 1 ? `${w.name} · ${dimLabel(w.dimension)}` : dimLabel(w.dimension);
    b.title = `${w.name} (${w.dimension}) ${w.bounds[2] - w.bounds[0]}×${w.bounds[3] - w.bounds[1]}`;
    if (w.name === worldName) b.className = 'on';
    b.onclick = () => switchWorld(w.name);
    el.appendChild(b);
  }
}

const KIND_COLORS = { plains: '#6aa84f', meadow: '#8bc34a', forest: '#2e7d32', hills: '#7cb342', mountains: '#90a4ae', peaks: '#eceff1', plateau: '#c0a060', badlands: '#e07b39', desert: '#e6d08a', valley: '#9ccc65', swamp: '#5d7a5a', beach: '#f1e2a8', ocean: '#3f76e4', volcano: '#444', nether_wastes: '#8e2b2b', crimson: '#b0202a', warped: '#16867a' };

function renderChips() {
  const el = $('chips');
  el.innerHTML = '';
  if (!world) return;
  for (const z of world.zones) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `<i style="background:${KIND_COLORS[z.kind] || '#888'}"></i>${z.id}${z.name ? ' ' + z.name : ''}`;
    c.title = `${z.kind} · ${z.biome.replace('minecraft:', '')}`;
    c.onclick = () => flyTo(z.cx, z.cz, 520);
    el.appendChild(c);
  }
}

function fmtArgs(args) {
  if (!args) return '';
  return Object.entries(args)
    .filter(([k]) => k !== 'world')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(', ')
    .slice(0, 220);
}

function entryEl(e, isNew) {
  const d = document.createElement('div');
  d.className = 'entry' + (isNew ? ' new' : '');
  d.innerHTML = `<span class="w">${e.world} · ${e.ms}ms</span><span class="tn"></span> <span style="color:var(--muted)">· mapedit</span><div class="args"></div><div class="sum"></div>`;
  d.querySelector('.tn').textContent = e.tool;
  d.querySelector('.args').textContent = fmtArgs(e.args);
  d.querySelector('.sum').textContent = e.summary;
  return d;
}

function renderLog() {
  const el = $('log');
  el.innerHTML = '';
  const ents = [...state.history.entries].reverse();
  for (const e of ents) el.appendChild(entryEl(e, false));
  $('logmeta').textContent = `${state.history.entries.length} 条修改 · ${state.history.redo} 可重做 · ${state.calls} 次调用`;
}

// ------------------------------------------------------------------ world switching
function clearChunks() {
  for (const [, c] of chunks) disposeChunk(c);
  chunks.clear();
  queue = [];
}

function disposeChunk(c) {
  if (!c.group) return;
  scene.remove(c.group);
  c.group.traverse((o) => o.geometry && o.geometry.dispose());
  c.group = null;
}

function switchWorld(name) {
  worldName = name;
  world = state.worlds.find((w) => w.name === name);
  clearChunks();
  if (overview?.mesh) {
    scene.remove(overview.mesh);
    overview.mesh.geometry.dispose();
  }
  overview = null;
  renderWorldTabs();
  renderChips();
  loadOverview().then(() => {
    buildBorders();
    buildLabels();
    fitView(true);
  });
}

// ------------------------------------------------------------------ overview
let overviewTimer = null;
function scheduleOverview() {
  clearTimeout(overviewTimer);
  overviewTimer = setTimeout(() => loadOverview().then(buildBorders), 500);
}

async function loadOverview() {
  if (!worldName) return;
  const buf = await (await api(`/api/overview?world=${encodeURIComponent(worldName)}`)).arrayBuffer();
  const dv = new DataView(buf);
  const x0 = dv.getInt32(0, true), z0 = dv.getInt32(4, true), nx = dv.getUint32(8, true), nz = dv.getUint32(12, true), step = dv.getUint32(16, true);
  const n = nx * nz;
  const pos = new Float32Array(n * 3);
  const col = new Uint8Array(n * 3);
  const h = new Int16Array(n);
  const water = new Uint8Array(n);
  let o = 20;
  for (let i = 0; i < n; i++) {
    const y = dv.getInt16(o, true);
    h[i] = y;
    const ix = i % nx, iz = (i / nx) | 0;
    pos[i * 3] = x0 + ix * step;
    pos[i * 3 + 1] = y + 1 - 0.9;
    pos[i * 3 + 2] = z0 + iz * step;
    col[i * 3] = dv.getUint8(o + 2);
    col[i * 3 + 1] = dv.getUint8(o + 3);
    col[i * 3 + 2] = dv.getUint8(o + 4);
    water[i] = dv.getUint8(o + 5);
    o += 6;
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < nz - 1; iz++)
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, overviewMat);
  mesh.name = 'overview';
  if (overview?.mesh) {
    scene.remove(overview.mesh);
    overview.mesh.geometry.dispose();
  }
  scene.add(mesh);
  overview = { x0, z0, nx, nz, step, h, water, mesh };
}

function heightAt(x, z) {
  if (!overview) return 64;
  const { x0, z0, nx, nz, step, h } = overview;
  const ix = Math.max(0, Math.min(nx - 1, Math.round((x - x0) / step)));
  const iz = Math.max(0, Math.min(nz - 1, Math.round((z - z0) / step)));
  return h[iz * nx + ix];
}

// ------------------------------------------------------------------ zones
function buildBorders() {
  if (borders) {
    scene.remove(borders);
    borders.geometry.dispose();
    borders = null;
  }
  if (!world || !world.zones.length || !overview) return;
  const pts = [];
  const [bx0, bz0, bx1, bz1] = world.bounds;
  const clampx = (v) => Math.max(bx0, Math.min(bx1, v));
  const clampz = (v) => Math.max(bz0, Math.min(bz1, v));
  const seen = new Set();
  for (const z of world.zones) {
    const p = z.polygon;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const key = [a, b].map((q) => q.map((v) => Math.round(v)).join(',')).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(2, Math.ceil(len / 6));
      for (let s = 0; s < n; s++) {
        const t0 = s / n, t1 = (s + 1) / n;
        const xa = clampx(a[0] + (b[0] - a[0]) * t0), za = clampz(a[1] + (b[1] - a[1]) * t0);
        const xb = clampx(a[0] + (b[0] - a[0]) * t1), zb = clampz(a[1] + (b[1] - a[1]) * t1);
        pts.push(xa, heightAt(xa, za) + 2.5, za, xb, heightAt(xb, zb) + 2.5, zb);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  borders = new THREE.LineSegments(g, borderMat);
  borders.visible = $('lyBorders').checked;
  scene.add(borders);
}

function buildLabels() {
  const root = $('labels');
  root.innerHTML = '';
  labels.length = 0;
  if (!world) return;
  for (const z of world.zones) {
    const d = document.createElement('div');
    d.className = 'label';
    d.innerHTML = `${z.id}${z.name ? `<small>${z.name}</small>` : ''}`;
    root.appendChild(d);
    labels.push({ el: d, x: z.cx, z: z.cz, kind: 'zone' });
  }
  for (const g of world.gates || []) {
    const d = document.createElement('div');
    d.className = 'label gate';
    d.textContent = `◆ ${g.id}`;
    root.appendChild(d);
    labels.push({ el: d, x: g.x, z: g.z, kind: 'gate' });
  }
}

const tmpV = new THREE.Vector3();
function updateLabels() {
  const showZ = $('lyNames').checked, showG = $('lyGates').checked;
  const camDist = camera.position.distanceTo(controls.target);
  for (const l of labels) {
    const show = l.kind === 'zone' ? showZ : showG && camDist < 2600;
    if (!show) {
      l.el.style.display = 'none';
      continue;
    }
    tmpV.set(l.x, heightAt(l.x, l.z) + (l.kind === 'zone' ? 18 : 6), l.z).project(camera);
    if (tmpV.z > 1 || tmpV.x < -1.1 || tmpV.x > 1.1 || tmpV.y < -1.1 || tmpV.y > 1.1) {
      l.el.style.display = 'none';
      continue;
    }
    l.el.style.display = 'block';
    l.el.style.left = `${(tmpV.x * 0.5 + 0.5) * window.innerWidth}px`;
    l.el.style.top = `${(-tmpV.y * 0.5 + 0.5) * window.innerHeight}px`;
  }
}

// ------------------------------------------------------------------ chunks
function parseChunk(buf, cx, cz) {
  const dv = new DataView(buf);
  const nO = dv.getUint32(0, true), nW = dv.getUint32(4, true);
  let off = 8;
  const part = (n) => {
    const pos = new Int16Array(buf, off, n * 3);
    off += n * 6;
    off = (off + 3) & ~3;
    const col = new Uint8Array(buf, off, n * 4);
    off += n * 4;
    return { pos, col };
  };
  const o = part(nO), w = part(nW);
  const group = new THREE.Group();
  group.position.set(cx * 16, 0, cz * 16);
  group.scale.set(1 / 8, 1 / 8, 1 / 8);
  for (const [p, mat, isWater] of [[o, chunkMat, false], [w, waterMat, true]]) {
    if (!p.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(p.col, 4, true));
    const m = new THREE.Mesh(g, mat);
    m.userData.water = isWater;
    m.visible = isWater ? $('lyWater').checked : true;
    m.renderOrder = isWater ? 2 : 0;
    group.add(m);
  }
  group.userData.tris = (nO + nW) / 3;
  return group;
}

async function fetchChunk(key) {
  const c = chunks.get(key);
  if (!c || c.loading) return;
  c.loading = true;
  c.stale = false;
  const [cx, cz] = key.split(',').map(Number);
  const wn = worldName;
  inflight++;
  try {
    const buf = await (await api(`/api/chunk?world=${encodeURIComponent(wn)}&cx=${cx}&cz=${cz}`)).arrayBuffer();
    if (wn !== worldName || !chunks.has(key)) return;
    const group = parseChunk(buf, cx, cz);
    group.visible = $('lyDetail').checked;
    disposeChunk(c);
    c.group = group;
    scene.add(group);
  } catch (e) {
    console.warn('chunk', key, e);
  } finally {
    inflight--;
    c.loading = false;
    if (c.stale) queue.unshift(key);
  }
}

function updateWanted() {
  if (!world || !$('lyDetail').checked) return;
  const R = +$('slDetail').value;
  const t = controls.target;
  const dist = camera.position.distanceTo(t);
  const [bx0, bz0, bx1, bz1] = world.bounds;
  const tcx = Math.floor(t.x / 16), tcz = Math.floor(t.z / 16);
  const near = dist < R * 16 * 5;
  const want = new Set();
  if (near) {
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R) continue;
        const cx = tcx + dx, cz = tcz + dz;
        if (cx * 16 < bx0 || cz * 16 < bz0 || cx * 16 >= bx1 || cz * 16 >= bz1) continue;
        want.add(`${cx},${cz}`);
      }
  }
  // unload far chunks
  const keep = (R + 3) * (R + 3);
  for (const [key, c] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    if (!near || (cx - tcx) ** 2 + (cz - tcz) ** 2 > keep) {
      disposeChunk(c);
      chunks.delete(key);
    }
  }
  const add = [];
  for (const key of want) {
    if (!chunks.has(key)) {
      chunks.set(key, { group: null, stale: false, loading: false });
      add.push(key);
    }
  }
  add.sort((a, b) => {
    const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number);
    return (ax - tcx) ** 2 + (az - tcz) ** 2 - ((bx - tcx) ** 2 + (bz - tcz) ** 2);
  });
  queue.push(...add);
}

function pumpQueue() {
  while (inflight < 6 && queue.length) {
    const key = queue.shift();
    if (chunks.has(key)) fetchChunk(key);
  }
}
setInterval(updateWanted, 350);
setInterval(pumpQueue, 30);

// ------------------------------------------------------------------ pulses (edit highlight)
function pulse(x0, z0, x1, z1) {
  if (!$('lyPulse').checked) return;
  const y = Math.max(heightAt((x0 + x1) / 2, (z0 + z1) / 2), heightAt(x0, z0), heightAt(x1, z1)) + 6;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y, z0], 3));
  const m = new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 1, depthTest: false });
  const line = new THREE.Line(g, m);
  line.renderOrder = 10;
  scene.add(line);
  pulses.push({ line, t0: performance.now() });
}

function updatePulses(now) {
  pulses = pulses.filter((p) => {
    const k = (now - p.t0) / 1600;
    if (k >= 1) {
      scene.remove(p.line);
      p.line.geometry.dispose();
      p.line.material.dispose();
      return false;
    }
    p.line.material.opacity = 1 - k;
    return true;
  });
}

// ------------------------------------------------------------------ camera
let flight = null;
function flyTo(x, z, dist = 300, dir = null) {
  const y = heightAt(x, z);
  const target = new THREE.Vector3(x, y, z);
  const off = dir || camera.position.clone().sub(controls.target).normalize();
  const pos = target.clone().add(off.multiplyScalar(dist));
  flight = { t0: performance.now(), dur: 700, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: pos, toT: target };
}

function fitView(instant = false) {
  if (!world) return;
  const [x0, z0, x1, z1] = world.bounds;
  const size = Math.max(x1 - x0, z1 - z0);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const t = new THREE.Vector3(cx, 64, cz);
  const p = new THREE.Vector3(cx, size * 0.72, cz + size * 0.62);
  if (instant) {
    controls.target.copy(t);
    camera.position.copy(p);
  } else {
    flight = { t0: performance.now(), dur: 700, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: p, toT: t };
  }
}

function camPreset(kind) {
  if (kind === 'fit') return fitView();
  const t = controls.target;
  const d = camera.position.distanceTo(t);
  const dir = kind === 'top' ? new THREE.Vector3(0, 1, 0.002).normalize() : new THREE.Vector3(0, 0.75, 0.66).normalize();
  flyTo(t.x, t.z, d, dir);
}

document.querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => camPreset(b.dataset.cam)));

// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastProbe = 0;
function pick(ev) {
  mouse.x = (ev.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  const objs = [];
  for (const [, c] of chunks) if (c.group && c.group.visible) objs.push(...c.group.children.filter((m) => !m.userData.water));
  const hits = ray.intersectObjects(objs, false);
  if (hits.length) return hits[0].point;
  if (overview?.mesh) {
    const h = ray.intersectObject(overview.mesh, false);
    if (h.length) return h[0].point;
  }
  return null;
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  const now = performance.now();
  if (now - lastProbe < 120 || !worldName) return;
  lastProbe = now;
  const p = pick(ev);
  if (!p) return;
  probe(p.x - 0.01, p.z - 0.01);
});

async function probe(x, z) {
  try {
    const d = await (await api(`/api/probe?world=${encodeURIComponent(worldName)}&x=${x}&z=${z}`)).json();
    const zone = d.zone ? `${d.zone.id}${d.zone.name ? ' ' + d.zone.name : ''}` : '—';
    const block = (d.block || '—').replace('minecraft:', '');
    $('cursor').innerHTML = `<div class="z"></div><div></div><div></div>`;
    const rows = $('cursor').children;
    rows[0].textContent = `${zone} · ${d.zone ? d.zone.kind : ''}`;
    rows[1].textContent = `${block}`;
    rows[2].textContent = `X ${d.x} Y ${d.y ?? '—'} Z ${d.z} · ${d.biome.replace('minecraft:', '')}`;
    $('stPos').textContent = `X ${d.x} Y ${d.y ?? '—'} Z ${d.z}`;
    $('stChunk').textContent = `区块 ${d.chunk[0]},${d.chunk[1]}`;
    $('stZone').textContent = zone;
    $('stBlock').textContent = block;
  } catch (e) {}
}

renderer.domElement.addEventListener('dblclick', (ev) => {
  const p = pick(ev);
  if (p) flyTo(p.x, p.z, Math.min(camera.position.distanceTo(controls.target), 160));
});

// ------------------------------------------------------------------ websocket
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('wsdot').classList.add('ok');
    $('wsstate').textContent = '实时';
  };
  ws.onclose = () => {
    $('wsdot').classList.remove('ok');
    $('wsstate').textContent = '断开，重连中';
    setTimeout(connect, 1000);
  };
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    onEvent(ev);
  };
}

function onEvent(ev) {
  switch (ev.type) {
    case 'hello':
    case 'resync':
      loadState().then(() => { clearChunks(); scheduleOverview(); });
      break;
    case 'worlds':
    case 'zones':
      loadState();
      break;
    case 'history':
      loadState();
      break;
    case 'log': {
      state.history.entries.push(ev.entry);
      state.history.redo = 0;
      $('log').prepend(entryEl(ev.entry, true));
      $('logmeta').textContent = `${state.history.entries.length} 条修改 · 0 可重做 · ${state.calls} 次调用`;
      break;
    }
    case 'call':
      state.calls = ev.calls;
      $('activity').textContent = `${ev.ok ? '✓' : '✗'} ${ev.tool} · ${ev.ms} ms · 共 ${ev.calls} 次调用`;
      break;
    case 'dirty':
      if (ev.world !== worldName) break;
      scheduleOverview();
      if (ev.chunks === 'all') {
        for (const [key, c] of chunks) { c.stale = true; queue.unshift(key); }
        if (world) pulse(...world.bounds);
      } else {
        let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
        for (const [cx, cz] of ev.chunks) {
          x0 = Math.min(x0, cx * 16); z0 = Math.min(z0, cz * 16); x1 = Math.max(x1, cx * 16 + 16); z1 = Math.max(z1, cz * 16 + 16);
          const key = `${cx},${cz}`;
          const c = chunks.get(key);
          if (c) { c.stale = true; queue.unshift(key); }
        }
        if (ev.chunks.length) pulse(x0, z0, x1, z1);
      }
      break;
    case 'progress': {
      const pct = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
      $('exBar').style.width = pct + '%';
      $('exportMsg').textContent = `写出区块 ${ev.done.toLocaleString()} / ${ev.total.toLocaleString()} · ${ev.label}`;
      $('activity').textContent = `导出 ${ev.label} ${pct}%`;
      break;
    }
    case 'exported':
      toast(`已导出：${ev.path}`);
      break;
  }
}

// ------------------------------------------------------------------ UI wiring
$('undoBtn').onclick = async () => { const r = await callTool('undo'); toast(r.text); };
$('redoBtn').onclick = async () => { const r = await callTool('redo'); toast(r.text); };
$('lyDetail').onchange = (e) => { for (const [, c] of chunks) if (c.group) c.group.visible = e.target.checked; };
$('lyBorders').onchange = (e) => { if (borders) borders.visible = e.target.checked; };
$('lyWater').onchange = (e) => { for (const [, c] of chunks) c.group?.children.forEach((m) => { if (m.userData.water) m.visible = e.target.checked; }); };
$('slLight').oninput = (e) => {
  const k = +e.target.value / 100;
  chunkMat.color.setScalar(k);
  waterMat.color.setScalar(k);
  ambient.intensity = 1.25 * k;
  sun.intensity = 1.6 * k;
};
function applyFog() {
  if (!world) return;
  const size = Math.max(world.bounds[2] - world.bounds[0], world.bounds[3] - world.bounds[1]);
  const f = +$('slFog').value / 100;
  scene.fog.near = size * (0.15 + (1 - f) * 2.5);
  scene.fog.far = size * (0.6 + (1 - f) * 5);
}
$('slFog').oninput = applyFog;
$('shot').onclick = () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `mapedit-${worldName || 'view'}-${Date.now()}.png`;
  a.click();
};
$('exportBtn').onclick = () => {
  $('exportModal').style.display = 'flex';
  if (!$('exPath').value) $('exPath').value = `exports/${$('exName').value || 'TheWorld'}`;
};
$('exClose').onclick = () => ($('exportModal').style.display = 'none');
$('exGo').onclick = async () => {
  $('exportMsg').textContent = '导出中…';
  $('exBar').style.width = '0%';
  const r = await callTool('export', { path: $('exPath').value, level_name: $('exName').value || 'TheWorld' });
  $('exBar').style.width = r.ok ? '100%' : '0%';
  $('exportMsg').textContent = (r.ok ? '✓ ' : '✗ ') + r.text;
};
$('helpBtn').onclick = () => ($('helpModal').style.display = 'flex');
$('helpClose').onclick = () => ($('helpModal').style.display = 'none');
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    (e.shiftKey ? $('redoBtn') : $('undoBtn')).click();
  } else if (e.key === 't') camPreset('top');
  else if (e.key === 'o') camPreset('oblique');
  else if (e.key === 'f') camPreset('fit');
  else if (e.key === 'Escape') document.querySelectorAll('.modal-bg').forEach((m) => (m.style.display = 'none'));
});

// ------------------------------------------------------------------ loop
let frames = 0, lastFps = performance.now(), fps = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (flight) {
    const k = Math.min(1, (now - flight.t0) / flight.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(flight.fromP, flight.toP, e);
    controls.target.lerpVectors(flight.fromT, flight.toT, e);
    if (k >= 1) flight = null;
  }
  controls.update();
  updatePulses(now);
  renderer.render(scene, camera);
  updateLabels();
  frames++;
  if (now - lastFps > 1000) {
    fps = Math.round((frames * 1000) / (now - lastFps));
    frames = 0;
    lastFps = now;
    let built = 0;
    for (const [, c] of chunks) if (c.group) built++;
    const tris = renderer.info.render.triangles;
    $('perf').textContent = `${fps} fps · ${built} 区块已建 · 队列 ${queue.length} · 三角 ${(tris / 1e6).toFixed(2)}M`;
    if (world) {
      const [x0, z0, x1, z1] = world.bounds;
      $('stWorld').textContent = `${world.name} · ${dimLabel(world.dimension)} ${x1 - x0} × ${z1 - z0}`;
    }
    applyFog();
  }
}
requestAnimationFrame(loop);
connect();
