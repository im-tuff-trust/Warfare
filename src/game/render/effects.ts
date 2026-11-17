import * as THREE from 'three';

// GPU point-sprite particles (one draw call per blend mode), debris and light flashes.

interface P { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; s0: number; s1: number; r: number; g: number; b: number; r1: number; g1: number; b1: number; a: number; drag: number; grav: number; }

class ParticlePool {
  points: THREE.Points;
  private ps: P[] = [];
  private pos: Float32Array; private col: Float32Array; private size: Float32Array; private alpha: Float32Array;
  private geo: THREE.BufferGeometry;
  constructor(public cap: number, additive: boolean, scale: { value: number }) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3); this.size = new Float32Array(cap); this.alpha = new Float32Array(cap);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { scale, additive: { value: additive ? 1 : 0 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA; varying float vSeed; uniform float scale;
        void main(){ vC = color; vA = alpha; vSeed = fract(sin(dot(position.xz, vec2(12.9898,78.233)))*43758.5453);
          vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = min(900.0, size * scale / max(0.5, -mv.z)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA; varying float vSeed; uniform float additive;
        void main(){ vec2 p = gl_PointCoord*2.0-1.0; float d = dot(p,p); if(d>1.0) discard;
          float n = 0.75 + 0.25*sin((p.x+vSeed*6.0)*5.0)*sin((p.y-vSeed*4.0)*5.0);
          float a = (additive > 0.5 ? pow(1.0-d, 1.6) : (1.0-d)*n) * vA;
          gl_FragColor = vec4(vC, a); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
  }
  spawn(p: Partial<P> & { x: number; y: number; z: number }) {
    if (this.ps.length >= this.cap) this.ps.shift();
    this.ps.push({ vx: 0, vy: 0, vz: 0, life: 0, max: 1, s0: 1, s1: 2, r: 1, g: 1, b: 1, r1: -1, g1: 0, b1: 0, a: 1, drag: 0.5, grav: 0, ...p } as P);
  }
  update(dt: number) {
    const ps = this.ps;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k - p.grav * dt; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      ps[w++] = p;
    }
    ps.length = w;
    for (let i = 0; i < w; i++) {
      const p = ps[i];
      const t = p.life / p.max;
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      const r1 = p.r1 < 0 ? p.r : p.r1, g1 = p.r1 < 0 ? p.g : p.g1, b1 = p.r1 < 0 ? p.b : p.b1;
      this.col[i * 3] = p.r + (r1 - p.r) * t; this.col[i * 3 + 1] = p.g + (g1 - p.g) * t; this.col[i * 3 + 2] = p.b + (b1 - p.b) * t;
      this.size[i] = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
      this.alpha[i] = p.a * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
    }
    this.geo.setDrawRange(0, w);
    for (const n of ['position', 'color', 'size', 'alpha']) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
  clear() { this.ps.length = 0; }
}

interface Debris { m: THREE.Matrix4; p: THREE.Vector3; v: THREE.Vector3; r: THREE.Vector3; rot: THREE.Euler; life: number; s: number; }

export class Effects {
  smoke: ParticlePool; fire: ParticlePool;
  scale = { value: 600 };
  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private lights: { l: THREE.PointLight; t: number; max: number }[] = [];
  private emitters: { pos: () => THREE.Vector3 | null; kind: 'fire' | 'smoke' | 'wreck'; acc: number; alive: () => boolean }[] = [];
  heightAt: (x: number, z: number) => number = () => 0;
  private c = new THREE.Color();

  constructor(private scene: THREE.Scene, quality: 'low' | 'medium' | 'high') {
    const cap = quality === 'low' ? 1500 : quality === 'medium' ? 3000 : 5000;
    this.smoke = new ParticlePool(cap, false, this.scale);
    this.fire = new ParticlePool(Math.floor(cap / 2), true, this.scale);
    scene.add(this.smoke.points, this.fire.points);
    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x3a3530 }), 160);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    scene.add(this.debrisMesh);
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 40, 1.6);
      scene.add(l);
      this.lights.push({ l, t: 1, max: 1 });
    }
  }

  private col(hex: number) { this.c.setHex(hex); return { r: this.c.r, g: this.c.g, b: this.c.b }; }

  flash(pos: THREE.Vector3, intensity: number, dur = 0.12, range = 40) {
    let best = this.lights[0];
    for (const l of this.lights) if (l.t / l.max > best.t / best.max) best = l;
    best.l.position.copy(pos);
    best.l.intensity = intensity;
    best.l.distance = range;
    best.t = 0; best.max = dur;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, caliber: number, ground = true) {
    const s = Math.max(0.5, caliber / 40);
    for (let i = 0; i < 6; i++) {
      const k = Math.random();
      this.fire.spawn({ x: pos.x + dir.x * k * s, y: pos.y + dir.y * k * s, z: pos.z + dir.z * k * s, vx: dir.x * 20 * k, vy: dir.y * 20 * k, vz: dir.z * 20 * k,
        max: 0.08 + Math.random() * 0.06, s0: s * 1.6, s1: s * 0.6, ...this.col(0xffc060), r1: 1, g1: 0.4, b1: 0.1, a: 1, drag: 8 });
    }
    if (caliber >= 20) {
      for (let i = 0; i < 10; i++) {
        const sp = (Math.random() - 0.5) * 2;
        this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * (8 + Math.random() * 8) + sp, vy: dir.y * 8 + Math.random() * 1.5, vz: dir.z * (8 + Math.random() * 8) + sp,
          max: 1.5 + Math.random() * 1.5, s0: s * 1.2, s1: s * 5, ...this.col(0xb0aaa0), a: 0.35, drag: 2.2, grav: -0.3 });
      }
      this.flash(pos, caliber / 6, 0.08, 25 + caliber / 3);
      if (ground && caliber >= 70) {
        // blast dust kicked up around the tank
        const y = this.heightAt(pos.x, pos.z);
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          this.smoke.spawn({ x: pos.x + Math.cos(a) * 2, y: y + 0.5, z: pos.z + Math.sin(a) * 2, vx: Math.cos(a) * 6, vy: 0.5, vz: Math.sin(a) * 6, max: 2.5, s0: 2, s1: 6, ...this.col(0x9a8a70), a: 0.25, drag: 1.5 });
        }
      }
    }
  }

  explosion(pos: THREE.Vector3, size: number, kind: 'he' | 'bomb' | 'ammo' | 'small' | 'building' = 'he', dustCol = 0x8a7a60) {
    const n = Math.min(60, 10 + size * 6);
    for (let i = 0; i < n; i++) {
      const v = randDir().multiplyScalar(size * (2 + Math.random() * 6));
      v.y = Math.abs(v.y) * 1.3;
      this.fire.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: v.x, vy: v.y, vz: v.z, max: 0.25 + Math.random() * 0.4 * Math.sqrt(size), s0: size * 1.4, s1: size * 3.2,
        ...this.col(0xffd080), r1: 0.9, g1: 0.25, b1: 0.05, a: 1, drag: 4 });
    }
    const dc = this.col(kind === 'building' ? 0x9a9284 : dustCol);
    for (let i = 0; i < n * 1.2; i++) {
      const v = randDir().multiplyScalar(size * (1 + Math.random() * 4));
      v.y = Math.abs(v.y) * 1.6 + size;
      const dark = kind === 'ammo' || Math.random() < 0.4;
      this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: v.x, vy: v.y, vz: v.z, max: 2.5 + Math.random() * 3 * Math.sqrt(size), s0: size * 1.5, s1: size * (5 + Math.random() * 3),
        ...(dark ? this.col(0x2a2622) : dc), a: dark ? 0.6 : 0.5, drag: 1.6, grav: -0.4 });
    }
    const dn = Math.min(30, Math.floor(size * (kind === 'building' ? 8 : 4)));
    for (let i = 0; i < dn; i++) this.addDebris(pos, size);
    this.flash(pos, 8 + size * 12, 0.25 + size * 0.05, 30 + size * 15);
    if (kind === 'ammo') {
      for (let i = 0; i < 25; i++) {
        const v = randDir().multiplyScalar(15 + Math.random() * 20);
        v.y = Math.abs(v.y) * 2;
        this.fire.spawn({ x: pos.x, y: pos.y + 1, z: pos.z, vx: v.x, vy: v.y, vz: v.z, max: 1.2 + Math.random(), s0: 0.6, s1: 0.2, ...this.col(0xffb050), a: 1, drag: 0.6, grav: 9 });
      }
    }
  }

  impact(pos: THREE.Vector3, normal: THREE.Vector3, kind: 'ricochet' | 'pen' | 'nonpen' | 'ground' | 'building' | 'water' | 'small', size = 1, dustCol = 0x8a7a60) {
    if (kind === 'water') {
      for (let i = 0; i < 20; i++) this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: (Math.random() - 0.5) * 4, vy: 8 + Math.random() * 10 * size, vz: (Math.random() - 0.5) * 4, max: 1.4, s0: 1, s1: 3, ...this.col(0xd8e4ec), a: 0.6, drag: 0.6, grav: 9 });
      return;
    }
    if (kind === 'ground' || kind === 'building' || kind === 'small') {
      const s = kind === 'small' ? 0.3 : size;
      const dc = this.col(kind === 'building' ? 0x9a9284 : dustCol);
      for (let i = 0; i < (kind === 'small' ? 3 : 14); i++) {
        const v = normal.clone().multiplyScalar(4 + Math.random() * 8).add(randDir().multiplyScalar(3));
        this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: v.x * s, vy: v.y * s, vz: v.z * s, max: 1.2 + Math.random() * 1.5, s0: 0.8 * s + 0.3, s1: 3 * s + 0.6, ...dc, a: 0.55, drag: 2, grav: 2 });
      }
      if (kind !== 'small') for (let i = 0; i < 4; i++) this.addDebris(pos, 0.4 * s);
      return;
    }
    // metal impact sparks
    const n = kind === 'ricochet' ? 14 : 22;
    for (let i = 0; i < n; i++) {
      const v = (kind === 'ricochet' ? normal.clone().multiplyScalar(6) : new THREE.Vector3()).add(randDir().multiplyScalar(6 + Math.random() * 10));
      this.fire.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: v.x, vy: v.y, vz: v.z, max: 0.25 + Math.random() * 0.35, s0: 0.35, s1: 0.1, ...this.col(0xffe0a0), a: 1, drag: 1, grav: 9 });
    }
    for (let i = 0; i < 6; i++) this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: normal.x * 2, vy: normal.y * 2 + 0.5, vz: normal.z * 2, max: 1, s0: 0.5, s1: 2, ...this.col(0x8a8580), a: 0.4, drag: 2 });
    this.flash(pos, kind === 'pen' ? 6 : 3, 0.06, 15);
  }

  exhaust(pos: THREE.Vector3, throttle: number, dir: THREE.Vector3) {
    this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 1.5 + (Math.random() - 0.5) * 0.5, vy: 0.8, vz: dir.z * 1.5 + (Math.random() - 0.5) * 0.5,
      max: 1.2 + throttle, s0: 0.4, s1: 1.6 + throttle, ...this.col(0x4a4744), a: 0.12 + throttle * 0.25, drag: 1, grav: -0.5 });
  }

  trackDust(pos: THREE.Vector3, speed: number, col: number) {
    this.smoke.spawn({ x: pos.x + (Math.random() - 0.5), y: pos.y + 0.3, z: pos.z + (Math.random() - 0.5), vx: (Math.random() - 0.5), vy: 0.6 + Math.random(), vz: (Math.random() - 0.5),
      max: 1.5 + speed * 0.1, s0: 0.8, s1: 2.5 + speed * 0.15, ...this.col(col), a: Math.min(0.35, speed * 0.03), drag: 1.2 });
  }

  trail(pos: THREE.Vector3, smoke: boolean) {
    if (smoke) this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, max: 2.5, s0: 1.2, s1: 3.5, ...this.col(0x2a2622), a: 0.45, drag: 0.4, grav: -0.5 });
    else this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, max: 0.6, s0: 0.3, s1: 0.8, ...this.col(0xe8e8e8), a: 0.18, drag: 0.4 });
  }

  /** Persistent fire/smoke emitter attached to a position provider. */
  attach(pos: () => THREE.Vector3 | null, kind: 'fire' | 'smoke' | 'wreck', alive: () => boolean) {
    this.emitters.push({ pos, kind, acc: 0, alive });
  }

  private addDebris(pos: THREE.Vector3, size: number) {
    if (this.debris.length >= 160) this.debris.shift();
    const v = randDir().multiplyScalar(5 + Math.random() * 10 * Math.sqrt(size));
    v.y = Math.abs(v.y) * 1.5 + 3;
    this.debris.push({ m: new THREE.Matrix4(), p: pos.clone(), v, r: randDir().multiplyScalar(8), rot: new THREE.Euler(), life: 3 + Math.random() * 3, s: 0.1 + Math.random() * 0.25 * Math.sqrt(size) });
  }

  update(dt: number) {
    for (const e of this.emitters) {
      if (!e.alive()) continue;
      const p = e.pos();
      if (!p) continue;
      e.acc += dt;
      const rate = e.kind === 'fire' ? 0.03 : e.kind === 'wreck' ? 0.12 : 0.08;
      while (e.acc > rate) {
        e.acc -= rate;
        if (e.kind === 'fire') {
          this.fire.spawn({ x: p.x + (Math.random() - 0.5) * 1.2, y: p.y, z: p.z + (Math.random() - 0.5) * 1.2, vx: (Math.random() - 0.5) * 0.8, vy: 2 + Math.random() * 2.5, vz: (Math.random() - 0.5) * 0.8,
            max: 0.5 + Math.random() * 0.5, s0: 1.6, s1: 0.6, ...this.col(0xffb040), r1: 0.8, g1: 0.15, b1: 0.02, a: 0.9, drag: 0.5 });
          if (Math.random() < 0.5) this.smoke.spawn({ x: p.x, y: p.y + 1.5, z: p.z, vx: (Math.random() - 0.5), vy: 3 + Math.random() * 2, vz: (Math.random() - 0.5), max: 4 + Math.random() * 3, s0: 1.5, s1: 7, ...this.col(0x1e1a18), a: 0.55, drag: 0.3 });
        } else {
          this.smoke.spawn({ x: p.x + (Math.random() - 0.5), y: p.y + 0.5, z: p.z + (Math.random() - 0.5), vx: (Math.random() - 0.5) * 0.6 + 0.4, vy: 1.8 + Math.random(), vz: (Math.random() - 0.5) * 0.6,
            max: 5 + Math.random() * 4, s0: 1.2, s1: 6, ...this.col(e.kind === 'wreck' ? 0x2a2624 : 0x55504a), a: e.kind === 'wreck' ? 0.4 : 0.3, drag: 0.3 });
        }
      }
    }
    this.emitters = this.emitters.filter((e) => e.alive());
    this.smoke.update(dt); this.fire.update(dt);
    for (const l of this.lights) {
      l.t += dt;
      l.l.intensity = l.t < l.max ? l.l.intensity * Math.pow(0.02, dt / l.max) : 0;
    }
    let w = 0;
    for (const d of this.debris) {
      d.life -= dt;
      if (d.life <= 0) continue;
      d.v.y -= 9.8 * dt;
      d.p.addScaledVector(d.v, dt);
      const gy = this.heightAt(d.p.x, d.p.z);
      if (d.p.y < gy) { d.p.y = gy; d.v.multiplyScalar(0.3); d.v.y = Math.abs(d.v.y) * 0.3; d.r.multiplyScalar(0.5); }
      d.rot.x += d.r.x * dt; d.rot.y += d.r.y * dt; d.rot.z += d.r.z * dt;
      d.m.compose(d.p, new THREE.Quaternion().setFromEuler(d.rot), new THREE.Vector3(d.s, d.s, d.s));
      this.debrisMesh.setMatrixAt(w, d.m);
      this.debris[w++] = d;
    }
    this.debris.length = w;
    this.debrisMesh.count = w;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.smoke.points, this.fire.points, this.debrisMesh);
    for (const l of this.lights) this.scene.remove(l.l);
  }
}

function randDir(): THREE.Vector3 {
  const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
}
