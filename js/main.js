// ОНИ ЗДЕСЬ — AR-хоррор в браузере телефона.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sfx, vibrate } from './audio.js';
import { Look } from './look.js';
import { MONSTERS, Monster } from './monster.js';

const $ = (s) => document.querySelector(s);
const FLOOR = -1.45;               // телефон держат примерно на высоте 1.45 м
const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
const DEBUG = new URLSearchParams(location.search).has('debug');

const DIFF = {
  easy: { label: 'Тихая ночь', goal: 3, lurk: 16, speed: 0.85, win: 1.25, feint: 0.5, cue: true, drain: 1.6 },
  normal: { label: 'Тёмная ночь', goal: 4, lurk: 12, speed: 1.0, win: 1.0, feint: 1.0, cue: false, drain: 2.2 },
  hard: { label: 'Кошмар', goal: 6, lurk: 9, speed: 1.2, win: 0.85, feint: 1.6, cue: false, drain: 3.0 },
};

const settings = { monster: 'peeker', diff: 'normal', realTorch: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('oz-settings') || '{}')); } catch (e) { /* приватный режим */ }
const saveSettings = () => { try { localStorage.setItem('oz-settings', JSON.stringify(settings)); } catch (e) { /* ок */ } };

// ------------------------------------------------------------------ сцена --
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 60);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0x8a9bb5, 0x1a140f, 0.55));
const moon = new THREE.DirectionalLight(0x9fb4ff, 0.35);
moon.position.set(-2, 4, 1);
scene.add(moon);

const torch = new THREE.SpotLight(0xffe2b8, 0, 0, 0.42, 0.55, 1.6);
torch.position.set(0.05, -0.05, 0);
camera.add(torch);
torch.target.position.set(0, 0, -1);
camera.add(torch.target);

const look = new Look(camera, canvas);
const sfx = new Sfx();
const loader = new GLTFLoader();
const cache = {};
let M = null;   // текущий монстр
let G = null;   // состояние партии
let stream = null;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // примерно как у основной камеры телефона: ~62° по длинной стороне кадра
  camera.fov = w < h ? 62 : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(31)) / camera.aspect));
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// --------------------------------------------------------- камера телефона --
async function startCamera() {
  if (stream) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    document.body.classList.add('no-cam');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const v = $('#cam');
    v.srcObject = stream;
    await v.play().catch(() => {});
    document.body.classList.add('has-cam');
    document.body.classList.remove('no-cam');
    return true;
  } catch (e) {
    document.body.classList.add('no-cam');
    return false;
  }
}

async function realTorch(on) {
  if (!stream || !settings.realTorch) return;
  const tr = stream.getVideoTracks()[0];
  try {
    const cap = tr.getCapabilities ? tr.getCapabilities() : {};
    if (cap.torch) await tr.applyConstraints({ advanced: [{ torch: on }] });
  } catch (e) { /* фонарик недоступен — не страшно */ }
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ок */ }
}

// ------------------------------------------------------------------- меню --
function buildMenu() {
  const cards = $('#cards');
  cards.innerHTML = '';
  for (const [id, d] of Object.entries(MONSTERS)) {
    const b = document.createElement('button');
    b.className = 'card' + (id === settings.monster ? ' sel' : '');
    b.dataset.id = id;
    b.innerHTML = `<img src="${d.img}" alt="" loading="lazy"><span class="cname">${d.name}</span>
      <span class="threat">${'▰'.repeat(d.threat)}${'▱'.repeat(5 - d.threat)}</span><span class="cdesc">${d.desc}</span>`;
    b.onclick = () => {
      settings.monster = id;
      saveSettings();
      document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c === b));
      sfx.click(900, 0.15);
    };
    cards.appendChild(b);
  }
  document.querySelectorAll('#diff button').forEach((b) => {
    b.classList.toggle('sel', b.dataset.d === settings.diff);
    b.onclick = () => {
      settings.diff = b.dataset.d;
      saveSettings();
      document.querySelectorAll('#diff button').forEach((x) => x.classList.toggle('sel', x === b));
    };
  });
  const rt = $('#realTorch');
  rt.checked = settings.realTorch;
  rt.onchange = () => { settings.realTorch = rt.checked; saveSettings(); };
}

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.body.dataset.screen = id;
}

async function startGame() {
  sfx.init();
  await look.enable();
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await screen.orientation.lock('portrait').catch(() => {});
    }
  } catch (e) { /* iOS не умеет — играем так */ }
  keepAwake();
  show('loading');
  const camOk = await startCamera();
  $('#camMsg').hidden = camOk;
  try {
    if (!cache[settings.monster]) cache[settings.monster] = await new Monster(settings.monster).load(loader);
  } catch (e) {
    $('#loadText').textContent = 'Не удалось загрузить модель. Обнови страницу.';
    console.error(e);
    return;
  }
  if (M) scene.remove(M.root);
  M = cache[settings.monster];
  scene.add(M.root);
  newGame();
}

// ------------------------------------------------------------------ партия --
function newGame() {
  const D = DIFF[settings.diff];
  G = {
    phase: '', pt: 0, wins: 0, goal: D.goal, battery: 100, shock: 100, torch: false,
    a: Math.PI, r: 6, target: 0, stepT: 0, lurkT: 0, find: 0, feinted: false, agg: 1, dur: 0,
    started: performance.now(), shocks: 0, hit: 0, breathT: 2, creakT: rand(4, 9), vibT: 0, away: 0,
    screeched: false, scareFlash: 0, msgT: 0,
  };
  M.reveal = 0;
  M.U.uFlash.value = 0;
  M.U.uGlitch.value = 0;
  setTorch(false);
  look.recenter();
  $('#mName').textContent = MONSTERS[settings.monster].name;
  renderPips();
  show('hud');
  setPhase('intro');
}

function setPhase(p) {
  G.phase = p;
  G.pt = 0;
  const MD = M.def, D = DIFF[settings.diff];
  if (p === 'intro') hint('Медленно осмотрись вокруг. Слушай.', 3);
  if (p === 'roam') {
    // уходит туда, где ты сейчас НЕ смотришь — ищи по звуку шагов
    G.target = wrap(look.yawOf() + Math.PI + rand(-1.3, 1.3));
    G.dur = rand(4, 8) / (G.agg * D.speed);
    G.find = 0;
    M.U.uGlitch.value = 0;
  }
  if (p === 'lurk') {
    G.lurkT = 0;
    G.find = 0;
    G.breathT = 1;
    hint('Оно затаилось рядом. Найди его фонарём.', 3);
  }
  if (p === 'reveal') {
    G.dur = rand(...MD.wait) / G.agg;
    G.screeched = false;
    G.away = 0;
    sfx.glitch(0, 0.6);
    vibrate([60, 40, 60]);
    hint('Не отводи взгляд…', 2);
  }
  if (p === 'charge') {
    sfx.screech(0, MD.scream ? 0.2 : 0.45);
    vibrate(200);
  }
  if (p === 'stun') {
    G.hit++;
    M.U.uFlash.value = 1.2;
    M.U.uGlitch.value = 1;
    hint('Отбился! Оно вернётся…', 2.2);
  }
  if (p === 'scare') {
    setTorch(true, true);
    M.reveal = 1;
    sfx.scream();
    vibrate([400, 60, 300, 60, 500]);
    document.body.classList.add('scaring');
  }
}

function hint(text, sec = 2.5) {
  const h = $('#hint');
  h.textContent = text;
  h.classList.add('on');
  G.msgT = sec;
}

function renderPips() {
  $('#pips').innerHTML = Array.from({ length: G.goal }, (_, i) => `<i class="${i < G.wins ? 'on' : ''}"></i>`).join('');
}

function setTorch(on, force = false) {
  if (!G) return;
  if (on && G.battery <= 0 && !force) { sfx.denied(); hint('Батарея села…', 1.5); return; }
  if (G.torch === on) return;
  G.torch = on;
  document.body.classList.toggle('torch-on', on);
  $('#torchBtn').classList.toggle('on', on);
  sfx.click(on ? 1500 : 900, 0.2);
  realTorch(on);
}

function shock() {
  if (!G || ['scare', 'stun', 'over', 'won', ''].includes(G.phase)) return;
  if (G.shock < 100) { sfx.denied(); vibrate(30); return; }
  const MD = M.def, D = DIFF[settings.diff];
  G.shock = 0;
  G.shocks++;
  sfx.zap();
  flash('shock');
  vibrate([30, 30, 80]);
  const inView = viewInfo().aim < 1.3;
  if (G.phase === 'charge' && G.r <= MD.window[1] * D.win && inView) {
    setPhase('stun');
  } else if (G.phase === 'charge') {
    hint(G.r > MD.window[1] * D.win ? 'СЛИШКОМ РАНО!' : 'ПРОМАХ!', 1.2);
    G.agg *= 1.06;
  } else if (G.phase === 'reveal') {
    hint('Ты его разозлил!', 1.2);
    setPhase('charge');
  } else {
    hint('Разряд в пустоту…', 1.2);
  }
}

function finish(won) {
  const D = DIFF[settings.diff];
  G.phase = won ? 'won' : 'over';
  setTorch(false);
  sfx.setStatic(0);
  sfx.setHeart(0, 0);
  M.reveal = 0;
  document.body.classList.remove('scaring');
  const sec = Math.round((performance.now() - G.started) / 1000);
  $('#overTitle').textContent = won ? 'РАССВЕТ' : 'ТЕБЯ НАШЛИ';
  $('#overTitle').dataset.text = $('#overTitle').textContent;
  $('#overSub').textContent = won
    ? `Ты пережил ночь с монстром «${M.def.name}».`
    : `${M.def.name} добрался до тебя.`;
  $('#overStats').innerHTML = `<li><b>${G.wins}/${G.goal}</b> отбито атак</li><li><b>${sec} с</b> в комнате</li>
    <li><b>${G.shocks}</b> разрядов шокера</li><li><b>${D.label}</b></li>`;
  $('#overBg').style.backgroundImage = `url(${M.def.img})`;
  $('#over').classList.toggle('won', won);
  show('over');
}

// ------------------------------------------------------- обзор и прицел --
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _c = new THREE.Vector3();
function viewInfo() {
  // центр тела монстра (для ползущей — ниже)
  M.root.getWorldPosition(_c);
  _c.y += M.def.gait === 'crawl' ? 0.45 : 1.1;
  camera.getWorldDirection(_f);
  _v.copy(_c).sub(camera.position);
  const dist = _v.length();
  const cos = _v.normalize().dot(_f);
  _v.copy(_c).project(camera);
  const front = cos > 0;
  const aim = front ? Math.hypot(_v.x, _v.y * 0.7) : 9;
  return { cos, aim, front, dist };
}

function placeMonster() {
  M.root.position.set(-Math.sin(G.a) * G.r, FLOOR, -Math.cos(G.a) * G.r);
  M.root.lookAt(0, FLOOR, 0);
}

function panOf(a) { return -Math.sin(wrap(a - look.yawOf())); }

// --------------------------------------------------------------- игровой цикл --
function step(dt) {
  const MD = M.def, D = DIFF[settings.diff];
  G.pt += dt;
  const agg = G.agg * D.speed;
  const crawl = MD.gait === 'crawl';
  let mode = 'idle', staticLvl = 0, heartRate = 70, heartVol = 0.15;

  // батарея и шокер
  if (G.torch) {
    G.battery -= D.drain * dt;
    if (G.battery <= 0) { G.battery = 0; setTorch(false); hint('Батарея села…', 2); }
  } else G.battery = Math.min(100, G.battery + 0.9 * dt);
  G.shock = Math.min(100, G.shock + dt * 31);

  // случайные звуки дома
  G.creakT -= dt;
  if (G.creakT <= 0) { G.creakT = rand(7, 16); sfx.creak(); }

  const vi = viewInfo();

  switch (G.phase) {
    case 'intro':
      G.r = 6;
      M.reveal = 0;
      if (G.pt > 3) setPhase('roam');
      break;

    case 'roam': {
      mode = 'walk';
      M.reveal = 0;
      const d = wrap(G.target - G.a);
      G.a = wrap(G.a + Math.sign(d) * Math.min(Math.abs(d), MD.roamSpeed * agg * dt));
      G.r += (3.6 - G.r) * dt * 0.5;
      if (MD.teleport && Math.random() < MD.teleport * 0.25 * dt) {
        G.a = wrap(G.a + rand(1.5, 4.5));
        G.target = wrap(look.yawOf() + Math.PI + rand(-1.3, 1.3));
        sfx.glitch(panOf(G.a), 0.3);
      }
      G.stepT -= dt;
      if (G.stepT <= 0) {
        G.stepT = (crawl ? 0.28 : MD.gait === 'glide' ? 0.9 : 0.55) / Math.sqrt(agg);
        sfx.footstep(panOf(G.a), clamp(2.6 / G.r, 0.15, 1) * (MD.gait === 'glide' ? 0.6 : 1), crawl);
      }
      staticLvl = Math.max(0, vi.cos - 0.85) * 1.2;
      heartRate = 75;
      if (G.pt > G.dur && Math.abs(d) < 0.15) setPhase('lurk');
      else if (G.pt > G.dur + 5) setPhase('lurk');
      break;
    }

    case 'lurk': {
      mode = 'lurk';
      G.lurkT += dt;
      G.r += (2.7 - G.r) * dt * 0.6;
      const lurkMax = D.lurk / G.agg;
      const near = vi.front && vi.aim < 0.9;
      const aimed = vi.front && vi.aim < 0.38;
      if (aimed && G.torch) G.find += dt / 1.1;
      else G.find = Math.max(0, G.find - dt * 0.35);
      M.reveal = 0.015 + (G.torch && near ? 0.08 : 0) + G.find * 0.45;
      M.U.uGlitch.value = 0.25 + G.find * 0.4;
      staticLvl = Math.max(0, (vi.cos - 0.55) / 0.45) * 0.35 + G.find * 0.35;
      heartRate = 80 + 70 * (G.lurkT / lurkMax);
      heartVol = 0.25 + 0.5 * (G.lurkT / lurkMax);
      G.breathT -= dt;
      if (G.breathT <= 0) { G.breathT = rand(2.5, 4); sfx.breath(panOf(G.a), 0.5); }
      G.vibT -= dt;
      if (near && G.vibT <= 0) { G.vibT = 0.5; vibrate(15); }
      if (G.find >= 1) {
        if (!G.feinted && Math.random() < MD.feint * D.feint) {
          G.feinted = true;
          sfx.glitch(panOf(G.a), 0.7);
          hint('Обманка! Оно ушло…', 1.6);
          setPhase('roam');
          G.dur *= 0.5;
        } else setPhase('reveal');
      } else if (G.lurkT > lurkMax) {
        hint('Оно устало ждать…', 1.2);
        setPhase('charge');
      } else if (G.lurkT > lurkMax - 3 && !G.warned) {
        G.warned = true;
        sfx.screech(panOf(G.a), 0.12);
      }
      break;
    }

    case 'reveal': {
      mode = 'stare';
      G.warned = false;
      M.reveal = Math.min(1, M.reveal + dt * 2.5);
      M.U.uGlitch.value = Math.max(0, M.U.uGlitch.value - dt * 1.5);
      staticLvl = 0.08 * (1 - M.reveal);
      heartRate = 140;
      heartVol = 0.7;
      G.away = vi.front && vi.aim < 1.2 ? 0 : G.away + dt;
      const wait = G.torch ? G.dur : G.dur * 0.5;
      if (MD.scream && !G.screeched && G.pt > wait - 0.7) { G.screeched = true; sfx.screech(panOf(G.a), 0.8); }
      if (G.pt > wait || G.away > 1.8) setPhase('charge');
      break;
    }

    case 'charge': {
      mode = 'charge';
      M.reveal = Math.min(1, M.reveal + dt * 4);
      M.U.uGlitch.value = 0.08;
      G.r -= MD.charge * agg * dt;
      if (MD.zigzag) G.a = wrap(G.a + Math.sin(G.pt * 9) * dt * 1.1 / Math.max(0.8, G.r));
      G.stepT -= dt;
      if (G.stepT <= 0) { G.stepT = crawl ? 0.12 : 0.2; sfx.footstep(panOf(G.a), 1, crawl); }
      heartRate = 170;
      heartVol = 0.9;
      const inWin = G.r <= MD.window[1] * D.win;
      $('#shockBtn').classList.toggle('cue', D.cue && inWin);
      if (G.r <= 0.55) { $('#shockBtn').classList.remove('cue'); setPhase('scare'); }
      break;
    }

    case 'stun': {
      mode = 'stun';
      M.U.uFlash.value = Math.max(0, M.U.uFlash.value - dt * 1.6);
      M.U.uGlitch.value = 1;
      if (G.pt > 0.7) M.reveal = Math.max(0, M.reveal - dt * 1.4);
      G.r += dt * 1.5;
      staticLvl = 0.3;
      $('#shockBtn').classList.remove('cue');
      if (G.pt > 1.6) {
        G.wins++;
        renderPips();
        if (G.wins >= G.goal) { finish(true); return; }
        G.agg *= 1.12;
        G.feinted = false;
        G.r = 4.5;
        setPhase('roam');
      }
      break;
    }

    case 'scare': {
      mode = 'scare';
      // монстр «в лицо»: голова прямо перед камерой
      camera.getWorldDirection(_f);
      M.root.position.set(_f.x * 1.2, FLOOR, _f.z * 1.2);
      M.root.lookAt(camera.position.x, FLOOR, camera.position.z);
      M.root.updateMatrixWorld(true);
      M.faceWorld(_v);
      _c.copy(_f).multiplyScalar(M.def.scareDist || 0.5);
      M.root.position.add(_c.sub(_v));
      M.root.position.x += rand(-0.02, 0.02);
      M.root.position.y += rand(-0.02, 0.02);
      M.U.uFlash.value = Math.random() < 0.15 ? 0.6 : 0;
      M.U.uGlitch.value = Math.random() < 0.3 ? 0.4 : 0;
      staticLvl = 0.25 + Math.random() * 0.2;
      if (Math.random() < 0.12) flash('red');
      if (G.pt > 1.9) { finish(false); return; }
      break;
    }
  }

  if (G.phase !== 'scare') placeMonster();
  M.update(dt, mode);
  if (G.phase === 'scare') M.faceTo(camera.position, (M.def.scareRoll || 0.12) + rand(-0.06, 0.06));

  sfx.setStatic(staticLvl);
  sfx.setHeart(heartRate, heartVol);
  drawStatic(staticLvl);

  // свет фонаря: лёгкое мерцание, при разряде батареи — сильнее
  const low = G.battery < 20 ? (Math.random() < 0.12 ? 0.2 : 1) : 1;
  torch.intensity = G.torch ? (G.phase === 'scare' ? 2.5 : 34) * low * (0.94 + Math.random() * 0.06) : 0;
  document.body.style.setProperty('--torch', G.torch ? (0.75 + 0.25 * low).toFixed(2) : 0);

  // HUD
  $('#battery i').style.width = G.battery.toFixed(0) + '%';
  $('#battery').classList.toggle('low', G.battery < 20);
  $('#shockBtn').style.setProperty('--charge', (G.shock / 100).toFixed(3));
  $('#shockBtn').classList.toggle('ready', G.shock >= 100);
  $('#signal').style.setProperty('--find', G.phase === 'lurk' ? G.find.toFixed(3) : 0);
  if (G.msgT > 0) { G.msgT -= dt; if (G.msgT <= 0) $('#hint').classList.remove('on'); }
  if (DEBUG) $('#debug').textContent = `${G.phase} a=${G.a.toFixed(2)} r=${G.r.toFixed(2)} yaw=${look.yawOf().toFixed(2)} aim=${vi.aim.toFixed(2)} find=${G.find.toFixed(2)} gyro=${look.gyro}`;
}

// ----------------------------------------------------------- помехи и вспышки --
const sc = $('#static');
sc.width = 96;
sc.height = 170;
const sctx = sc.getContext('2d');
const simg = sctx.createImageData(sc.width, sc.height);
const s32 = new Uint32Array(simg.data.buffer);
function drawStatic(level) {
  sc.style.opacity = clamp(level, 0, 0.9).toFixed(3);
  if (level < 0.01) return;
  for (let i = 0; i < s32.length; i++) {
    const v = (Math.random() * 255) | 0;
    s32[i] = 0xff000000 | (v << 16) | (v << 8) | v;
  }
  sctx.putImageData(simg, 0, 0);
}

function flash(kind) {
  const f = $('#flash');
  f.className = kind;
  f.animate([{ opacity: kind === 'red' ? 0.55 : 0.9 }, { opacity: 0 }], { duration: kind === 'red' ? 160 : 420, easing: 'ease-out' });
}

// ----------------------------------------------------------------- цикл --
let last = performance.now();
let paused = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (paused) return;
  look.update(dt);
  sfx.tick(dt);
  if (G && M && !['over', 'won'].includes(G.phase) && document.body.dataset.screen === 'hud') step(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
  if (paused) { sfx.suspend(); if (G) setTorch(false); } else { sfx.resume(); keepAwake(); }
});

// ---------------------------------------------------------------- кнопки --
$('#startBtn').onclick = startGame;
$('#howBtn').onclick = () => show('how');
$('#howBack').onclick = () => show('menu');
$('#retryBtn').onclick = () => { sfx.init(); newGame(); };
$('#menuBtn').onclick = () => { G = null; show('menu'); };
$('#exitBtn').onclick = () => { if (G) { setTorch(false); sfx.setStatic(0); sfx.setHeart(0, 0); document.body.classList.remove('scaring'); } G = null; if (M) M.reveal = 0; show('menu'); };
$('#torchBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); setTorch(!G.torch); });
$('#shockBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); shock(); });
$('#recenterBtn').onclick = () => { look.recenter(); sfx.click(1200, 0.1); };
addEventListener('keydown', (e) => {
  if (!G) return;
  if (e.code === 'KeyF') setTorch(!G.torch);
  if (e.code === 'Space') { e.preventDefault(); shock(); }
});

if (!window.isSecureContext) $('#secureMsg').hidden = false;
if (DEBUG) {
  $('#debug').hidden = false;
  window.__oz = { get G() { return G; }, get M() { return M; }, setPhase, look, camera };
}
buildMenu();
show('menu');
