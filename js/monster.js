// Загрузка моделей из Blender (glTF), шейдер «помех»/маскировки и процедурная анимация по именам суставов.
import * as THREE from 'three';

export const MONSTERS = {
  peeker: {
    name: 'Соглядатай',
    file: 'models/peeker.glb',
    img: 'img/peeker.jpg',
    desc: 'Лысый, морщинистый, с глазами навыкате. Долго прячется, а потом бросается без предупреждения.',
    threat: 3,
    gait: 'walk',
    roamSpeed: 0.55,
    charge: 3.4,
    window: [0.7, 1.7],
    wait: [0.5, 1.6],
    feint: 0.2,
    teleport: 0,
    face: [0, 0.13, 0.1],
    scareDist: 0.6,
  },
  pale: {
    name: 'Бледная',
    file: 'models/pale.glb',
    img: 'img/pale.jpg',
    desc: 'Слепые белые глаза, чёрные волосы. Исчезает и появляется в другом углу комнаты.',
    threat: 2,
    gait: 'glide',
    roamSpeed: 0.4,
    charge: 2.6,
    window: [0.7, 2.0],
    wait: [1.2, 2.6],
    feint: 0.4,
    teleport: 0.6,
  },
  screamer: {
    name: 'Крикунья',
    file: 'models/screamer.glb',
    img: 'img/screamer.jpg',
    desc: 'Её визг предупреждает о рывке — но рывок у неё самый быстрый.',
    threat: 4,
    gait: 'walk',
    roamSpeed: 0.6,
    charge: 4.0,
    window: [0.7, 1.6],
    wait: [0.8, 1.5],
    feint: 0.15,
    teleport: 0,
    scream: true,
  },
  crawler: {
    name: 'Ползущая',
    file: 'models/crawler.glb',
    img: 'img/crawler.jpg',
    desc: 'Ползает по полу зигзагами, сквозь волосы смотрит один глаз. Смотри вниз.',
    threat: 3,
    gait: 'crawl',
    roamSpeed: 0.5,
    charge: 3.0,
    window: [0.7, 1.7],
    wait: [0.9, 2.0],
    feint: 0.3,
    teleport: 0,
    zigzag: true,
    scareRoll: 0.55,
  },
};

const key = (s) => s.replace(/[^A-Za-z0-9]/g, '');

function patchMaterial(m, U) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uGlitch;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        float gRow = floor(position.y * 30.0 + uTime * 17.0);
        float gOn = step(0.9, fract(sin(gRow * 12.9898 + floor(uTime * 12.0)) * 43758.5453));
        gl_Position.x += uGlitch * gOn * (fract(sin(gRow * 3.7 + uTime) * 9631.3) - 0.5) * 0.35 * gl_Position.w;`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime; uniform float uReveal; uniform float uFlash;
        float hh(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        float nz = hh(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 24.0) * vec2(17.0, 31.0));
        if (nz > uReveal) discard;
        float edge = smoothstep(uReveal - 0.3, uReveal, nz) * (1.0 - step(0.999, uReveal));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.7, 0.82, 1.0) * (0.35 + 0.65 * hh(gl_FragCoord.xy + uTime)), edge * 0.9);
        gl_FragColor.rgb += uFlash * vec3(0.55, 0.75, 1.0);`
      );
  };
  m.customProgramCacheKey = () => 'monster-cloak';
  m.needsUpdate = true;
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const rnd = (a = 1) => (Math.random() * 2 - 1) * a;

export class Monster {
  constructor(id) {
    this.id = id;
    this.def = MONSTERS[id];
    this.U = { uTime: { value: 0 }, uReveal: { value: 0 }, uGlitch: { value: 0 }, uFlash: { value: 0 } };
    this.root = new THREE.Group();
    this.nodes = {};
    this.base = {};
    this.basePos = {};
    this.t = 0;
    this.phase = 0;
    this.tw = new THREE.Vector3();
    this.twc = new THREE.Vector3();
    this.twT = 0;
    this.headLocal = new THREE.Vector3();
  }

  async load(loader) {
    const g = await loader.loadAsync(this.def.file);
    this.model = g.scene;
    this.root.add(this.model);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => patchMaterial(m, this.U));
      }
      if (o.name) {
        const k = key(o.name);
        if (!this.nodes[k]) {
          this.nodes[k] = o;
          this.base[k] = o.quaternion.clone();
          this.basePos[k] = o.position.clone();
        }
      }
    });
    const crawl = this.def.gait === 'crawl';
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(crawl ? 0.9 : 0.8, crawl ? 1.6 : 0.7),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0 })
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.set(0, 0.005, crawl ? 0.25 : 0);
    this.root.add(this.blob);
    this.root.updateMatrixWorld(true);
    const head = this.nodes.Head;
    if (head) this.root.worldToLocal(head.getWorldPosition(this.headLocal));
    return this;
  }

  set reveal(v) {
    this.U.uReveal.value = v;
    this.root.visible = v > 0.002;
    if (this.blob) this.blob.material.opacity = Math.min(1, v * 1.2) * 0.7;
  }
  get reveal() { return this.U.uReveal.value; }

  rot(name, x, y = 0, z = 0) {
    const n = this.nodes[name];
    if (!n) return;
    _q.setFromEuler(_e.set(x, y, z));
    n.quaternion.copy(this.base[name]).multiply(_q);
  }

  /** mode: idle | walk | lurk | stare | charge | stun | scare */
  update(dt, mode) {
    this.t += dt;
    const t = this.t;
    this.U.uTime.value = t;
    const D = this.def;
    const crawl = D.gait === 'crawl';
    const glide = D.gait === 'glide';

    // резкие «дёрганые» повороты головы — цель меняется скачком, догоняется быстро
    this.twT -= dt;
    if (this.twT <= 0) {
      this.twT = mode === 'lurk' || mode === 'stare' ? 0.3 + Math.random() * 1.4 : 0.6 + Math.random() * 2;
      const k = mode === 'stare' ? 1.3 : 1;
      this.tw.set(rnd(0.25) * k, rnd(0.45) * k, rnd(0.5) * k);
    }
    this.twc.lerp(this.tw, 1 - Math.exp(-dt * 22));

    const moving = mode === 'walk' || mode === 'charge';
    const rate = mode === 'charge' ? (crawl ? 14 : 11) : crawl ? 7 : glide ? 2.5 : 5.2;
    if (moving) this.phase += dt * rate;
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const w = moving ? 1 : 0;
    const breath = Math.sin(t * 1.7) * 0.03;
    const J = mode === 'stun' ? 0.45 : mode === 'scare' ? 0.12 : 0;
    const j = () => rnd(J);
    const hips = this.nodes.Hips;

    if (!crawl) {
      const legA = (mode === 'charge' ? 0.8 : 0.42) * (glide ? 0.35 : 1);
      this.rot('ThighL', -s * legA * w + j(), 0, 0);
      this.rot('ThighR', s * legA * w + j(), 0, 0);
      this.rot('ShinL', Math.max(0, c) * 0.9 * legA * w, 0, 0);
      this.rot('ShinR', Math.max(0, -c) * 0.9 * legA * w, 0, 0);
      let ua = 0.05 + breath, uz = 0.08, fa = -0.2, hx = 0, spine = 0.05 + breath * 0.5;
      let jaw = 0.06 + Math.max(0, Math.sin(t * 0.9)) * 0.06;
      let hx2 = this.twc.x, hy = this.twc.y, hz = this.twc.z * 0.6;
      let armSwing = s * 0.35 * w;
      if (mode === 'lurk') { hz = 0.5 + this.twc.z * 0.5; jaw = 0.18; fa = -0.35; }
      if (mode === 'stare') { hz = 0.25 + this.twc.z; jaw = 0.3 + Math.sin(t * 7) * 0.05; ua = -0.25; fa = -0.6; uz = 0.25; }
      if (mode === 'charge') {
        ua = -1.45 + Math.sin(t * 13) * 0.12; uz = 0.2; fa = -0.25; hx = -0.4; armSwing = s * 0.15;
        spine = 0.32; jaw = 0.65 + Math.sin(t * 30) * 0.06; hx2 = -0.15 + this.twc.x * 0.3; hy = this.twc.y * 0.3; hz = this.twc.z * 0.4;
      }
      if (mode === 'scare') {
        ua = -2.0; uz = 0.45; fa = -0.7; hx = -0.6; spine = 0.25; jaw = 0.95; armSwing = 0;
        hx2 = -0.2 + rnd(0.08); hy = rnd(0.12); hz = rnd(0.15);
      }
      if (mode === 'stun') { jaw = 0.8; spine = -0.2; }
      this.rot('Spine', spine + j(), j(), j());
      this.rot('Neck', j() * 0.5, 0, 0);
      this.rot('Head', hx2 + j(), hy + j(), hz + j());
      this.rot('Jaw', jaw + Math.abs(j()), 0, 0);
      this.rot('UpperArmL', ua + armSwing + j(), 0, uz + j());
      this.rot('UpperArmR', ua - armSwing + j(), 0, -uz + j());
      this.rot('ForearmL', fa + j(), 0, 0);
      this.rot('ForearmR', fa + j(), 0, 0);
      this.rot('HandL', hx + j(), 0, 0);
      this.rot('HandR', hx + j(), 0, 0);
      if (hips) {
        const bob = moving && !glide ? Math.abs(s) * 0.035 : glide ? Math.sin(t * 2) * 0.03 + 0.04 : 0;
        hips.position.copy(this.basePos.Hips);
        hips.position.y += bob;
        this.rot('Hips', mode === 'charge' ? 0.08 : 0, Math.sin(this.phase) * 0.06 * w, glide ? Math.sin(t * 1.3) * 0.05 : 0);
      }
    } else {
      // Ползущая: базовая поза хранится в узлах модели, тут только отклонения от неё
      let a = 0.35 * w, head = this.twc, jaw = 0.1;
      let lift = 0;
      if (mode === 'charge') { a = 0.5; jaw = 0.6; }
      if (mode === 'lurk') { jaw = 0.25; }
      if (mode === 'stare') { jaw = 0.4; lift = -0.15; }
      if (mode === 'scare') { a = 0; lift = -0.9; jaw = 0.9; }
      this.rot('UpperArmL', s * a + lift + j(), 0, j());
      this.rot('UpperArmR', -s * a + lift + j(), 0, j());
      this.rot('ForearmL', Math.max(0, c) * a * 0.8 + j(), 0, 0);
      this.rot('ForearmR', Math.max(0, -c) * a * 0.8 + j(), 0, 0);
      this.rot('ThighL', -s * a * 0.8 + j(), 0, 0);
      this.rot('ThighR', s * a * 0.8 + j(), 0, 0);
      this.rot('Spine', breath + (mode === 'scare' ? -0.4 : 0) + j(), 0, 0);
      this.rot('Neck', (mode === 'scare' ? 0.35 : 0) + j(), 0, 0);
      this.rot('Head', head.x + j(), head.y + j(), head.z * 1.6 + j());
      this.rot('Jaw', jaw + Math.abs(j()), 0, 0);
      if (hips) {
        hips.position.copy(this.basePos.Hips);
        hips.position.y += Math.abs(s) * 0.03 * w + (mode === 'scare' ? 0.35 : 0);
        this.rot('Hips', mode === 'scare' ? -0.6 : 0, s * 0.12 * w, s * 0.08 * w);
      }
    }
  }

  /** Точка в центре лица (в локальных осях головы: вверх Y, вперёд Z). */
  faceWorld(out) {
    const h = this.nodes.Head;
    if (!h) return this.root.getWorldPosition(out);
    const f = this.def.face || [0, 0.1, 0.06];
    return h.localToWorld(out.set(f[0], f[1], f[2]));
  }

  /** Поворачивает голову лицом к точке (для скримера), с наклоном roll. */
  faceTo(target, roll = 0) {
    const h = this.nodes.Head;
    if (!h) return;
    h.parent.updateMatrixWorld(true);
    h.getWorldPosition(_p);
    _m.lookAt(target, _p, _up);
    _qw.setFromRotationMatrix(_m).multiply(_q.setFromEuler(_e.set(0, 0, roll)));
    h.parent.getWorldQuaternion(_qp).invert();
    h.quaternion.copy(_qp.multiply(_qw));
  }

  headWorld(out) {
    const h = this.nodes.Head;
    return h ? h.getWorldPosition(out) : this.root.getWorldPosition(out);
  }
}
