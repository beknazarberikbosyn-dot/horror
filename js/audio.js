// Все звуки синтезируются на лету через Web Audio — никаких аудиофайлов.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function distortion(k) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return c;
}

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this._heartT = 0;
    this.heartRate = 0;
    this.heartVol = 0;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = (this.ctx = new AC());
    this.master = c.createGain();
    this.master.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(c.destination);

    const len = c.sampleRate * 2;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.brown = c.createBuffer(1, len, c.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }
    this.curve = distortion(400);
    this._ambient();
    this._staticLoop();
  }

  suspend() { this.ctx && this.ctx.suspend(); }
  resume() { this.ctx && this.ctx.resume(); }

  _src(buf = this.noise, loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    return s;
  }

  _out(pan = 0, vol = 1) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = vol;
    if (pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      p.connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  _env(g, t, a, peak, d) {
    peak = Math.max(peak, 0.0002);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _ambient() {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = 0.05;
    g.connect(this.master);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    lp.connect(g);
    for (const f of [43.6, 44.1, 65.4]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = c.createGain();
    lg.gain.value = 60;
    lfo.connect(lg);
    lg.connect(lp.frequency);
    lfo.start();

    const n = this._src(this.brown, true);
    const ng = c.createGain();
    ng.gain.value = 0.05;
    const nf = c.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = 400;
    n.connect(nf);
    nf.connect(ng);
    ng.connect(this.master);
    n.start();
    this.ambientGain = g;
  }

  _staticLoop() {
    const c = this.ctx;
    const n = this._src(this.noise, true);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.6;
    this.staticGain = c.createGain();
    this.staticGain.gain.value = 0;
    n.connect(bp);
    bp.connect(this.staticGain);
    this.staticGain.connect(this.master);
    n.start();
  }

  setStatic(v) {
    if (!this.ctx) return;
    this.staticGain.gain.setTargetAtTime(clamp(v, 0, 1) * 0.22, this.ctx.currentTime, 0.05);
  }

  setHeart(rate, vol) { this.heartRate = rate; this.heartVol = vol; }

  tick(dt) {
    if (!this.ctx || this.heartRate <= 0 || this.heartVol <= 0.01) return;
    this._heartT -= dt;
    if (this._heartT <= 0) {
      this._heartT = 60 / this.heartRate;
      this._thump(this.heartVol);
      setTimeout(() => this._thump(this.heartVol * 0.7), 170);
    }
  }

  _thump(vol) {
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.13);
    const g = c.createGain();
    o.connect(g);
    g.connect(this.master);
    this._env(g, t, 0.01, 0.9 * vol, 0.16);
    o.start(t);
    o.stop(t + 0.25);
  }

  footstep(pan, vol, crawl = false) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(pan, vol);
    const n = this._src();
    const f = c.createBiquadFilter();
    f.type = crawl ? 'bandpass' : 'lowpass';
    f.frequency.value = crawl ? 1400 + Math.random() * 600 : 420 + Math.random() * 300;
    const g = c.createGain();
    n.connect(f);
    f.connect(g);
    g.connect(out);
    this._env(g, t, 0.004, crawl ? 0.5 : 0.9, crawl ? 0.06 : 0.14);
    n.start(t, Math.random() * 1.5, 0.3);
    if (!crawl) {
      const o = c.createOscillator();
      o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const og = c.createGain();
      o.connect(og);
      og.connect(out);
      this._env(og, t, 0.004, 0.8, 0.15);
      o.start(t);
      o.stop(t + 0.25);
    }
  }

  breath(pan, vol) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(pan, vol);
    const n = this._src();
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1300, t + 1.2);
    f.Q.value = 1.4;
    const g = c.createGain();
    n.connect(f);
    f.connect(g);
    g.connect(out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    n.start(t, Math.random(), 1.6);
  }

  creak(pan = Math.random() * 2 - 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(pan, 0.35);
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(60 + Math.random() * 40, t);
    o.frequency.linearRampToValueAtTime(90 + Math.random() * 60, t + 0.9);
    const fm = c.createOscillator();
    fm.frequency.value = 23;
    const fg = c.createGain();
    fg.gain.value = 30;
    fm.connect(fg);
    fg.connect(o.frequency);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 6;
    const g = c.createGain();
    o.connect(bp);
    bp.connect(g);
    g.connect(out);
    this._env(g, t, 0.25, 0.8, 0.8);
    o.start(t);
    fm.start(t);
    o.stop(t + 1.2);
    fm.stop(t + 1.2);
  }

  glitch(pan = 0, vol = 0.5) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(pan, vol);
    for (let i = 0; i < 6; i++) {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = 200 + Math.random() * 2200;
      const g = c.createGain();
      o.connect(g);
      g.connect(out);
      const s = t + i * 0.035;
      g.gain.setValueAtTime(0.25, s);
      g.gain.setValueAtTime(0, s + 0.03);
      o.start(s);
      o.stop(s + 0.04);
    }
  }

  screech(pan = 0, vol = 0.6) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(pan, vol);
    const ws = c.createWaveShaper();
    ws.curve = this.curve;
    ws.connect(out);
    for (const [f0, f1] of [[520, 1500], [760, 1900], [300, 900]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.7);
      const g = c.createGain();
      o.connect(g);
      g.connect(ws);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      o.start(t);
      o.stop(t + 0.9);
    }
  }

  scream() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(0, 1);
    const ws = c.createWaveShaper();
    ws.curve = this.curve;
    ws.connect(out);
    const parts = [[430, 820, 'sawtooth'], [300, 610, 'square'], [880, 1350, 'sawtooth'], [150, 95, 'sawtooth'], [1200, 2100, 'triangle']];
    for (const [f0, f1, type] of parts) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.22);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + 1.9);
      const lfo = c.createOscillator();
      lfo.frequency.value = 24 + Math.random() * 14;
      const lg = c.createGain();
      lg.gain.value = f0 * 0.09;
      lfo.connect(lg);
      lg.connect(o.frequency);
      const g = c.createGain();
      o.connect(g);
      g.connect(ws);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.3, t + 0.03);
      g.gain.setValueAtTime(0.3, t + 1.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
      o.start(t);
      lfo.start(t);
      o.stop(t + 2.1);
      lfo.stop(t + 2.1);
    }
    const n = this._src();
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const ng = c.createGain();
    n.connect(hp);
    hp.connect(ng);
    ng.connect(out);
    this._env(ng, t, 0.02, 0.6, 1.6);
    n.start(t, 0, 2);
  }

  zap() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = this._out(0, 0.8);
    const n = this._src();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2800;
    bp.Q.value = 1.5;
    const gate = c.createGain();
    gate.gain.value = 0;
    const sq = c.createOscillator();
    sq.type = 'square';
    sq.frequency.value = 55;
    const sg = c.createGain();
    sg.gain.value = 0.5;
    sq.connect(sg);
    sg.connect(gate.gain);
    n.connect(bp);
    bp.connect(gate);
    const g = c.createGain();
    gate.connect(g);
    g.connect(out);
    this._env(g, t, 0.005, 1, 0.55);
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.linearRampToValueAtTime(90, t + 0.5);
    const og = c.createGain();
    o.connect(og);
    og.connect(out);
    this._env(og, t, 0.005, 0.4, 0.5);
    n.start(t, 0, 0.7);
    sq.start(t);
    o.start(t);
    sq.stop(t + 0.7);
    o.stop(t + 0.7);
  }

  click(freq = 1800, vol = 0.25) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = c.createGain();
    o.connect(g);
    g.connect(this.master);
    this._env(g, t, 0.002, vol, 0.04);
    o.start(t);
    o.stop(t + 0.06);
  }

  denied() { this.click(220, 0.3); setTimeout(() => this.click(180, 0.3), 90); }
}

export function vibrate(p) {
  try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* нет вибро */ }
}
