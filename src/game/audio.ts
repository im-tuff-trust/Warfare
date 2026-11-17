// Procedural WebAudio sound: no downloaded assets. Engines, guns, explosions, impacts, ambience.

type V3 = { x: number; y: number; z: number };

export interface EngineSound { set(rpm: number, load: number, pos?: V3): void; stop(): void; }

export class GameAudio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private sfx!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private listenerPos: V3 = { x: 0, y: 0, z: 0 };
  volume = 0.7;
  private ambientStarted = false;
  private artilleryTimer = 0;

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
  }

  setVolume(v: number) { this.volume = v; if (this.ctx) this.master.gain.value = v; }

  setListener(pos: V3, fwd: V3, up: V3) {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t); l.upY.setValueAtTime(up.y, t); l.upZ.setValueAtTime(up.z, t);
    } else {
      (l as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(pos.x, pos.y, pos.z);
    }
  }

  private dist(p?: V3) {
    if (!p) return 0;
    const dx = p.x - this.listenerPos.x, dy = p.y - this.listenerPos.y, dz = p.z - this.listenerPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private panner(p: V3 | undefined, ref = 12): AudioNode {
    const ctx = this.ctx!;
    if (!p) return this.sfx;
    const pn = ctx.createPanner();
    pn.panningModel = 'equalpower';
    pn.distanceModel = 'inverse';
    pn.refDistance = ref; pn.rolloffFactor = 1; pn.maxDistance = 5000;
    if (pn.positionX) { pn.positionX.value = p.x; pn.positionY.value = p.y; pn.positionZ.value = p.z; }
    else (pn as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(p.x, p.y, p.z);
    pn.connect(this.sfx);
    return pn;
  }

  private noiseBurst(out: AudioNode, t0: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'lowpass', brown = false, decay = 4) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = brown ? this.brown : this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    void decay;
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }

  private tone(out: AudioNode, t0: number, dur: number, f0: number, f1: number, gain: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  private start(p?: V3) {
    // sound travels at 343 m/s
    return this.ctx!.currentTime + Math.min(3, this.dist(p) / 343);
  }

  cannon(p: V3 | undefined, caliber: number) {
    if (!this.ctx) return;
    const d = this.dist(p);
    if (d > 2500) return;
    const out = this.panner(p, 25);
    const t = this.start(p);
    const big = caliber / 75;
    this.noiseBurst(out, t, 0.6 + big * 0.5, 1400 - Math.min(900, d * 0.5), 0.7, 1.4 * Math.min(1.6, big + 0.3), 'lowpass');
    this.tone(out, t, 0.5 + big * 0.3, 90 / Math.max(0.6, big), 30, 1.3 * big);
    this.noiseBurst(out, t + 0.02, 1.8 + big, 260, 0.5, 0.5 * big, 'lowpass', true);
  }

  mg(p: V3 | undefined, caliber: number) {
    if (!this.ctx) return;
    if (this.dist(p) > 1500) return;
    const out = this.panner(p, 10);
    const t = this.start(p);
    this.noiseBurst(out, t, 0.07 + caliber / 400, 2600 - caliber * 40, 0.8, 0.35 + caliber / 60, 'bandpass');
    this.tone(out, t, 0.05, 180 - caliber * 2, 60, 0.2 + caliber / 60, 'square');
  }

  explosion(p: V3 | undefined, size: number) {
    if (!this.ctx) return;
    const d = this.dist(p);
    if (d > 3000) return;
    const out = this.panner(p, 20 + size * 10);
    const t = this.start(p);
    this.noiseBurst(out, t, 1.2 + size * 0.6, Math.max(250, 1200 - d * 0.6), 0.5, Math.min(2.2, 0.8 + size * 0.4));
    this.tone(out, t, 0.9 + size * 0.3, 70, 20, Math.min(2, 0.8 + size * 0.3));
    this.noiseBurst(out, t + 0.05, 2.5 + size, 180, 0.4, 0.6, 'lowpass', true);
    // debris patter
    if (d < 120) for (let i = 0; i < 6; i++) this.noiseBurst(out, t + 0.6 + Math.random() * 1.2, 0.05, 2500, 2, 0.08, 'bandpass');
  }

  ricochet(p?: V3) {
    if (!this.ctx) return;
    const out = this.panner(p, 8);
    const t = this.start(p);
    const f = 1800 + Math.random() * 1500;
    this.tone(out, t, 0.45, f, f * 0.55, 0.35, 'sine');
    this.noiseBurst(out, t, 0.08, 4000, 3, 0.5, 'bandpass');
  }

  armorHit(p: V3 | undefined, pen: boolean) {
    if (!this.ctx) return;
    const out = this.panner(p, 10);
    const t = this.start(p);
    this.noiseBurst(out, t, pen ? 0.5 : 0.3, pen ? 900 : 1800, 4, pen ? 1.4 : 0.9, 'bandpass');
    this.tone(out, t, pen ? 0.6 : 0.4, pen ? 320 : 620, pen ? 120 : 380, 0.6, 'triangle');
    this.tone(out, t, 0.25, 1240, 900, 0.18, 'square');
  }

  /** Muffled interior hit heard by the crew of the hit vehicle. */
  interiorHit(pen: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfx, t, pen ? 0.9 : 0.45, pen ? 500 : 900, 1.5, pen ? 2 : 1.2, 'lowpass');
    this.tone(this.sfx, t, 0.8, pen ? 140 : 420, 60, 1.0, 'triangle');
  }

  ground(p?: V3) {
    if (!this.ctx) return;
    if (this.dist(p) > 1200) return;
    const out = this.panner(p, 10);
    this.noiseBurst(out, this.start(p), 0.35, 600, 0.8, 0.6, 'lowpass');
  }

  click() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(this.sfx, t, 0.06, 900, 500, 0.15, 'square');
    this.noiseBurst(this.sfx, t + 0.05, 0.12, 2200, 2, 0.25, 'bandpass');
  }

  reloadDone(caliber: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfx, t, 0.12, 1500, 3, 0.35, 'bandpass');
    this.tone(this.sfx, t + 0.02, 0.18, 260 + 60 * (75 / caliber), 160, 0.3, 'triangle');
  }

  alarm() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone(this.sfx, t + i * 0.18, 0.12, 880, 860, 0.12, 'square');
  }

  ui(kind: 'hover' | 'select' | 'error' = 'select') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'error') this.tone(this.sfx, t, 0.25, 220, 150, 0.15, 'square');
    else this.tone(this.sfx, t, kind === 'hover' ? 0.04 : 0.09, kind === 'hover' ? 1400 : 700, kind === 'hover' ? 1300 : 1050, 0.08, 'triangle');
  }

  /** Continuous engine with harmonics, filtered noise and positional panning. */
  engine(kind: 'tank' | 'plane', base: number, positional: boolean): EngineSound {
    if (!this.ctx) return { set() {}, stop() {} };
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    let pn: PannerNode | null = null;
    if (positional) {
      pn = ctx.createPanner();
      pn.panningModel = 'equalpower'; pn.distanceModel = 'inverse'; pn.refDistance = kind === 'plane' ? 40 : 15; pn.rolloffFactor = 1.2;
      out.connect(pn).connect(this.sfx);
    } else out.connect(this.sfx);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 1;
    f.connect(out);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = kind === 'plane' ? 'sawtooth' : 'square';
    const o3 = ctx.createOscillator(); o3.type = 'triangle';
    const g1 = ctx.createGain(), g2 = ctx.createGain(), g3 = ctx.createGain();
    g1.gain.value = 0.35; g2.gain.value = 0.18; g3.gain.value = 0.25;
    o1.connect(g1).connect(f); o2.connect(g2).connect(f); o3.connect(g3).connect(f);
    // amplitude "firing" modulation
    const lfo = ctx.createOscillator(); lfo.type = 'square';
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.2;
    lfo.connect(lfoG).connect(out.gain);
    const nz = ctx.createBufferSource(); nz.buffer = this.brown; nz.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 300;
    const ng = ctx.createGain(); ng.gain.value = kind === 'plane' ? 0.5 : 0.8;
    nz.connect(nf).connect(ng).connect(out);
    // track squeal / clatter for tanks
    let clat: GainNode | null = null;
    let clatSrc: AudioBufferSourceNode | null = null;
    if (kind === 'tank') {
      clatSrc = ctx.createBufferSource(); clatSrc.buffer = this.noise; clatSrc.loop = true;
      const cf = ctx.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 1800; cf.Q.value = 2;
      clat = ctx.createGain(); clat.gain.value = 0;
      clatSrc.connect(cf).connect(clat).connect(out);
      clatSrc.start();
    }
    const nodes = [o1, o2, o3, lfo, nz];
    nodes.forEach((n) => n.start());
    let stopped = false;
    return {
      set: (rpm: number, load: number, pos?: V3) => {
        if (stopped) return;
        const t = ctx.currentTime;
        const fr = base * (0.6 + rpm * 1.2);
        o1.frequency.setTargetAtTime(fr, t, 0.08);
        o2.frequency.setTargetAtTime(fr * (kind === 'plane' ? 2.01 : 0.5), t, 0.08);
        o3.frequency.setTargetAtTime(fr * 1.5, t, 0.08);
        lfo.frequency.setTargetAtTime(fr / 4, t, 0.08);
        f.frequency.setTargetAtTime(300 + load * 900 + rpm * 500, t, 0.1);
        out.gain.setTargetAtTime((kind === 'plane' ? 0.25 : 0.3) * (0.4 + load * 0.6), t, 0.1);
        if (clat) clat.gain.setTargetAtTime(Math.min(0.12, rpm * 0.15) * (rpm > 0.1 ? 1 : 0), t, 0.1);
        if (pn && pos) {
          if (pn.positionX) { pn.positionX.setTargetAtTime(pos.x, t, 0.05); pn.positionY.setTargetAtTime(pos.y, t, 0.05); pn.positionZ.setTargetAtTime(pos.z, t, 0.05); }
        }
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        out.gain.setTargetAtTime(0, t, 0.1);
        setTimeout(() => { nodes.forEach((n) => { try { n.stop(); } catch { /* */ } }); try { clatSrc?.stop(); } catch { /* */ } out.disconnect(); }, 600);
      },
    };
  }

  siren(p: V3 | undefined, on: boolean, state: { node?: { o: OscillatorNode; g: GainNode } }) {
    if (!this.ctx) return;
    if (on && !state.node) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth';
      const g = this.ctx.createGain(); g.gain.value = 0;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 3;
      o.connect(f).connect(g).connect(this.panner(p, 60));
      o.start();
      state.node = { o, g };
    }
    if (state.node) {
      const t = this.ctx.currentTime;
      state.node.g.gain.setTargetAtTime(on ? 0.3 : 0, t, 0.3);
      state.node.o.frequency.setTargetAtTime(on ? 700 : 300, t, 1.5);
      if (!on) { const n = state.node; state.node = undefined; setTimeout(() => { try { n.o.stop(); } catch { /* */ } }, 1500); }
    }
  }

  startAmbient(windy: boolean) {
    if (!this.ctx || this.ambientStarted) return;
    this.ambientStarted = true;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = windy ? 500 : 350; f.Q.value = 0.6;
    const g = this.ctx.createGain(); g.gain.value = windy ? 0.06 : 0.035;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lg = this.ctx.createGain(); lg.gain.value = 0.02;
    lfo.connect(lg).connect(g.gain);
    src.connect(f).connect(g).connect(this.master);
    src.start(); lfo.start();
  }

  /** Distant artillery rumble for atmosphere. */
  tickAmbient(dt: number) {
    if (!this.ctx) return;
    this.artilleryTimer -= dt;
    if (this.artilleryTimer <= 0) {
      this.artilleryTimer = 4 + Math.random() * 10;
      const t = this.ctx.currentTime;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        this.noiseBurst(this.master, t + i * (0.3 + Math.random() * 0.8), 2.5, 140, 0.5, 0.25 + Math.random() * 0.2, 'lowpass', true);
      }
    }
  }

  shutdown() {
    if (this.ctx) { void this.ctx.close(); this.ctx = null; this.ambientStarted = false; }
  }
}

export const audio = new GameAudio();
