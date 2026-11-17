import * as THREE from 'three';
import { buildingGeometry, hedgeGeometry, rockGeometry, rubbleGeometry, treeGeometry, wallGeometry } from '../render/props';
import { fbm } from './noise';
import { CELL, GRID, HALF, PLAY, WORLD, generateMap, sampleGrid, type Building, type MapData } from './mapgen';

export interface RayHit { t: number; kind: 'terrain' | 'building' | 'water'; idx: number; point: THREE.Vector3; normal: THREE.Vector3; }

const BUCKET = 32;

/** Runtime world: terrain, props, collision and destruction. */
export class World {
  map: MapData;
  group = new THREE.Group();
  terrainMesh!: THREE.Mesh;
  groundCanvas!: HTMLCanvasElement;
  groundTex!: THREE.CanvasTexture;
  private buildingMeshes = new Map<number, THREE.Object3D>();
  private instanced = new Map<number, { mesh: THREE.InstancedMesh; i: number }>();
  private treeMeshes: THREE.InstancedMesh | null = null;
  private buckets = new Map<number, number[]>(); // building indices
  private treeBuckets = new Map<number, number[]>();
  private texDirty = 0;
  flagMeshes: { flag: THREE.Mesh; ring: THREE.Mesh; mat: THREE.MeshBasicMaterial; ringMat: THREE.MeshBasicMaterial }[] = [];
  water: THREE.Mesh | null = null;

  constructor(mapId: string, seed: number, private quality: 'low' | 'medium' | 'high') {
    this.map = generateMap(mapId, seed);
    for (const b of this.map.buildings) this.bucketAdd(this.buckets, b.x, b.z, Math.max(b.w, b.d) / 2, b.idx);
    for (const t of this.map.trees) this.bucketAdd(this.treeBuckets, t.x, t.z, 1, t.idx);
  }

  private key(i: number, j: number) { return (i + 100) * 1000 + (j + 100); }
  private bucketAdd(m: Map<number, number[]>, x: number, z: number, r: number, idx: number) {
    const i0 = Math.floor((x - r) / BUCKET), i1 = Math.floor((x + r) / BUCKET);
    const j0 = Math.floor((z - r) / BUCKET), j1 = Math.floor((z + r) / BUCKET);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      let arr = m.get(k);
      if (!arr) { arr = []; m.set(k, arr); }
      arr.push(idx);
    }
  }
  private query(m: Map<number, number[]>, x0: number, z0: number, x1: number, z1: number, out: Set<number>) {
    const i0 = Math.floor(Math.min(x0, x1) / BUCKET), i1 = Math.floor(Math.max(x0, x1) / BUCKET);
    const j0 = Math.floor(Math.min(z0, z1) / BUCKET), j1 = Math.floor(Math.max(z0, z1) / BUCKET);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) return;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = m.get(this.key(i, j));
      if (arr) for (const a of arr) out.add(a);
    }
  }

  height(x: number, z: number): number { return sampleGrid(this.map.heights, x, z); }
  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 1.5;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // ------------------------------------------------------------ build visuals
  build(scene: THREE.Scene) {
    const th = this.map.def.theme;
    this.buildTerrain();
    this.buildWater();
    this.buildProps();
    this.buildPoints();
    scene.add(this.group);
    void th;
  }

  private buildTerrain() {
    const N = GRID;
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const uv = new Float32Array((N + 1) * (N + 1) * 2);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const k = j * (N + 1) + i;
      pos[k * 3] = -HALF + i * CELL; pos[k * 3 + 1] = this.map.heights[k]; pos[k * 3 + 2] = -HALF + j * CELL;
      uv[k * 2] = i / N; uv[k * 2 + 1] = 1 - j / N;
    }
    const idx = new Uint32Array(N * N * 6);
    let p = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    this.paintGround();
    const mat = new THREE.MeshLambertMaterial({ map: this.groundTex });
    const detail = makeDetailTexture();
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.detailMap = { value: detail };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float d1 = texture2D(detailMap, vWPos.xz * 0.21).r;
          float d2 = texture2D(detailMap, vWPos.xz * 0.033).g;
          diffuseColor.rgb *= 0.78 + 0.32 * d1 * (0.7 + 0.6 * d2);`);
    };
    this.terrainMesh = new THREE.Mesh(g, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.name = 'terrain';
    this.group.add(this.terrainMesh);
  }

  private paintGround() {
    const th = this.map.def.theme;
    const S = this.quality === 'low' ? 768 : 1024;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const pal = th.ground.map((h) => new THREE.Color(h));
    const rock = new THREE.Color(th.rock), shore = new THREE.Color(th.shore);
    const c = new THREE.Color();
    const seed = this.map.seed;
    const n = new THREE.Vector3();
    for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
      const x = -HALF + (px / S) * WORLD, z = -HALF + (py / S) * WORLD;
      const t = (fbm(x / 140, z / 140, seed + 77, 3) + 1) / 2;
      const t2 = (fbm(x / 35, z / 35, seed + 78, 2) + 1) / 2;
      const ci = Math.min(pal.length - 1.001, t * (pal.length - 1));
      const i0 = Math.floor(ci);
      c.copy(pal[i0]).lerp(pal[i0 + 1], ci - i0).multiplyScalar(0.88 + t2 * 0.24);
      this.normal(x, z, n);
      const slope = 1 - n.y;
      if (slope > 0.12) c.lerp(rock, Math.min(1, (slope - 0.12) * 5));
      const hgt = this.height(x, z);
      if (this.map.water !== null && hgt < this.map.water + 1.2) c.lerp(shore, 0.8);
      if (this.map.oasis) {
        const d = Math.hypot(x - this.map.oasis.x, z - this.map.oasis.z);
        if (d < this.map.oasis.r) c.lerp(new THREE.Color(0x6a7a3a), (1 - d / this.map.oasis.r) * 0.85);
      }
      if (Math.max(Math.abs(x), Math.abs(z)) > PLAY + 5) c.multiplyScalar(0.92);
      const o = (py * S + px) * 4;
      img.data[o] = c.r * 255; img.data[o + 1] = c.g * 255; img.data[o + 2] = c.b * 255; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const sc = S / WORLD;
    const toPx = (x: number, z: number): [number, number] => [(x + HALF) * sc, (z + HALF) * sc];
    // fields with furrows
    for (const f of this.map.fields) {
      ctx.save();
      const [fx, fz] = toPx(f.x, f.z);
      ctx.translate(fx, fz); ctx.rotate(-f.rot);
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#' + new THREE.Color(f.color).getHexString();
      ctx.fillRect((-f.w / 2) * sc, (-f.d / 2) * sc, f.w * sc, f.d * sc);
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      for (let x = -f.w / 2; x < f.w / 2; x += 3) { ctx.beginPath(); ctx.moveTo(x * sc, (-f.d / 2) * sc); ctx.lineTo(x * sc, (f.d / 2) * sc); ctx.stroke(); }
      ctx.restore();
    }
    // roads
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of this.map.roads) {
      const pass = (w: number, col: string, alpha: number) => {
        ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = w * sc;
        ctx.beginPath();
        r.pts.forEach(([x, z], i) => { const [a, b] = toPx(x, z); if (i === 0) ctx.moveTo(a, b); else ctx.lineTo(a, b); });
        ctx.stroke();
      };
      const road = '#' + new THREE.Color(th.road).getHexString();
      if (r.rail) {
        pass(r.w, '#5a5048', 0.8); pass(r.w * 0.5, '#3a3430', 0.9);
      } else {
        pass(r.w + 2, '#000', 0.12); pass(r.w, road, 0.9); pass(r.w * 0.35, '#000', 0.06);
      }
    }
    ctx.globalAlpha = 1;
    // building foundations
    for (const b of this.map.buildings) {
      if (b.instanced) continue;
      ctx.save();
      const [bx, bz] = toPx(b.x, b.z);
      ctx.translate(bx, bz); ctx.rotate(-b.rot);
      ctx.fillStyle = 'rgba(40,35,30,0.35)';
      ctx.fillRect((-b.w / 2 - 2) * sc, (-b.d / 2 - 2) * sc, (b.w + 4) * sc, (b.d + 4) * sc);
      ctx.restore();
    }
    this.groundCanvas = cv;
    this.groundTex = new THREE.CanvasTexture(cv);
    this.groundTex.colorSpace = THREE.SRGBColorSpace;
    this.groundTex.anisotropy = 4;
  }

  /** Scorch / crater mark on the ground texture. */
  scorch(x: number, z: number, r: number) {
    const ctx = this.groundCanvas.getContext('2d')!;
    const S = this.groundCanvas.width, sc = S / WORLD;
    const px = (x + HALF) * sc, py = (z + HALF) * sc;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r * sc);
    g.addColorStop(0, 'rgba(20,16,12,0.75)');
    g.addColorStop(0.6, 'rgba(35,28,20,0.4)');
    g.addColorStop(1, 'rgba(40,30,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, r * sc, 0, Math.PI * 2); ctx.fill();
    this.texDirty = Math.max(this.texDirty, 0.0001);
  }

  private buildWater() {
    if (this.map.water === null) return;
    const g = new THREE.PlaneGeometry(WORLD * 1.5, WORLD * 1.5);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshPhongMaterial({ color: 0x3a5a6a, shininess: 90, specular: 0x88aacc, transparent: true, opacity: 0.88 });
    this.water = new THREE.Mesh(g, m);
    this.water.position.y = this.map.water;
    this.group.add(this.water);
  }

  private buildProps() {
    const bmat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const shadows = this.quality !== 'low';
    const hedges: Building[] = [], walls: Building[] = [], rocks: Building[] = [];
    for (const b of this.map.buildings) {
      if (b.type === 'hedge') { hedges.push(b); continue; }
      if (b.type === 'wall') { walls.push(b); continue; }
      if (b.type === 'rock') { rocks.push(b); continue; }
      const mesh = new THREE.Mesh(buildingGeometry(b), bmat);
      mesh.position.set(b.x, b.y, b.z);
      mesh.rotation.y = b.rot;
      mesh.castShadow = shadows; mesh.receiveShadow = shadows;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      this.group.add(mesh);
      this.buildingMeshes.set(b.idx, mesh);
    }
    const mk = (list: Building[], geo: THREE.BufferGeometry, tint: (b: Building) => number) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, bmat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
      list.forEach((b, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot);
        m.compose(new THREE.Vector3(b.x, b.y - 0.3, b.z), q, new THREE.Vector3(b.w, b.h, b.d));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.setHex(tint(b)));
        this.instanced.set(b.idx, { mesh: im, i });
      });
      im.castShadow = shadows; im.receiveShadow = shadows;
      this.group.add(im);
    };
    mk(hedges, hedgeGeometry(), () => 0xffffff);
    mk(walls, wallGeometry(), (b) => b.color);
    mk(rocks, rockGeometry(5), (b) => b.color);
    // trees
    const trees = this.map.trees;
    if (trees.length) {
      const im = new THREE.InstancedMesh(treeGeometry(this.map.def.theme.tree), bmat, trees.length);
      trees.forEach((t, i) => im.setMatrixAt(i, this.treeMatrix(t.x, t.y, t.z, t.s, t.rot, false, 0)));
      im.castShadow = shadows;
      this.group.add(im);
      this.treeMeshes = im;
    }
  }

  private treeMatrix(x: number, y: number, z: number, s: number, rot: number, fallen: boolean, fallDir: number) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0));
    if (fallen) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(fallDir), 0, -Math.sin(fallDir)), 1.45));
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.2, z), q, new THREE.Vector3(s, s, s));
  }

  private buildPoints() {
    for (const p of this.map.points) {
      const y = this.height(p.x, p.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 9, 6), new THREE.MeshLambertMaterial({ color: 0x777777 }));
      pole.position.set(p.x, y + 4.5, p.z);
      this.group.add(pole);
      const mat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.DoubleSide });
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5, 6, 1), mat);
      flag.position.set(p.x + 1.25, y + 8.1, p.z);
      this.group.add(flag);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 6, 48, 1, true), ringMat);
      ring.position.set(p.x, y + 1, p.z);
      this.group.add(ring);
      this.flagMeshes.push({ flag, ring, mat, ringMat });
    }
  }

  setPointOwner(i: number, owner: number, progress: number) {
    const f = this.flagMeshes[i];
    if (!f) return;
    const col = owner === 0 ? 0x4a90e2 : owner === 1 ? 0xe24a3a : 0xdddddd;
    f.mat.color.setHex(col);
    f.ringMat.color.setHex(col);
    const p = this.map.points[i];
    f.flag.position.y = this.height(p.x, p.z) + 1.5 + 6.6 * Math.max(0.05, Math.abs(progress));
  }

  update(dt: number, time: number) {
    for (const f of this.flagMeshes) {
      const pos = f.flag.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        pos.setZ(i, Math.sin(time * 4 + x * 2.2) * 0.15 * (x + 1.2));
      }
      pos.needsUpdate = true;
    }
    if (this.texDirty > 0) {
      this.texDirty += dt;
      if (this.texDirty > 0.6) { this.groundTex.needsUpdate = true; this.texDirty = 0; }
    }
  }

  // ------------------------------------------------------------ collisions
  /** Resolve a circle against building footprints. Returns push vector and list of building indices touched. */
  collideCircle(x: number, z: number, r: number, y: number, out: { px: number; pz: number; hits: number[]; trees: number[] }) {
    out.px = 0; out.pz = 0; out.hits.length = 0; out.trees.length = 0;
    const set = new Set<number>();
    this.query(this.buckets, x - r, z - r, x + r, z + r, set);
    for (const i of set) {
      const b = this.map.buildings[i];
      if (b.destroyed) continue;
      if (y > b.y + b.h + 0.5) continue;
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const dx = x + out.px - b.x, dz = z + out.pz - b.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const hw = b.w / 2, hd = b.d / 2;
      const cx = Math.max(-hw, Math.min(hw, lx)), cz = Math.max(-hd, Math.min(hd, lz));
      let ox = lx - cx, oz = lz - cz;
      let d = Math.hypot(ox, oz);
      if (d >= r) continue;
      if (d < 1e-4) {
        // centre inside: push out along the shallowest axis
        const px = hw - Math.abs(lx), pz = hd - Math.abs(lz);
        if (px < pz) { ox = Math.sign(lx) || 1; oz = 0; d = -px; } else { ox = 0; oz = Math.sign(lz) || 1; d = -pz; }
        const pen = r - d;
        const wx = ox * c + oz * s, wz = -ox * s + oz * c;
        out.px += wx * pen; out.pz += wz * pen;
      } else {
        const pen = r - d;
        ox /= d; oz /= d;
        const wx = ox * c + oz * s, wz = -ox * s + oz * c;
        out.px += wx * pen; out.pz += wz * pen;
      }
      out.hits.push(i);
    }
    const ts = new Set<number>();
    this.query(this.treeBuckets, x - r, z - r, x + r, z + r, ts);
    for (const i of ts) {
      const t = this.map.trees[i];
      if (t.fallen) continue;
      if ((t.x - x) ** 2 + (t.z - z) ** 2 < (r + 0.4) ** 2) out.trees.push(i);
    }
  }

  isInside(x: number, z: number, y: number): boolean {
    const set = new Set<number>();
    this.query(this.buckets, x - 1, z - 1, x + 1, z + 1, set);
    for (const i of set) {
      const b = this.map.buildings[i];
      if (b.destroyed || y > b.y + b.h || y < b.y - 1) continue;
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < b.w / 2 && Math.abs(lz) < b.d / 2) return true;
    }
    return false;
  }

  /** Raycast against terrain, water and buildings. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number, ignoreBuildings = false): RayHit | null {
    let best: RayHit | null = null;
    // terrain: march
    const step = Math.max(1.5, CELL * 0.6);
    let prevT = 0;
    let prevAbove = o.y - this.height(o.x, o.z);
    if (prevAbove < 0) return { t: 0, kind: 'terrain', idx: -1, point: o.clone(), normal: this.normal(o.x, o.z) };
    for (let t = step; t <= maxT + step; t += step) {
      const tt = Math.min(t, maxT);
      const x = o.x + d.x * tt, y = o.y + d.y * tt, z = o.z + d.z * tt;
      const above = y - this.height(x, z);
      if (above < 0) {
        let lo = prevT, hi = tt;
        for (let k = 0; k < 8; k++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m - this.height(o.x + d.x * m, o.z + d.z * m) < 0) hi = m; else lo = m;
        }
        const p = o.clone().addScaledVector(d, hi);
        best = { t: hi, kind: 'terrain', idx: -1, point: p, normal: this.normal(p.x, p.z) };
        break;
      }
      prevT = tt; prevAbove = above;
      if (tt >= maxT) break;
      if (y > 400 && d.y > 0) break;
    }
    const lim = best ? best.t : maxT;
    if (this.map.water !== null && d.y < 0) {
      const tw = (this.map.water - o.y) / d.y;
      if (tw > 0 && tw < lim && (!best || tw < best.t)) best = { t: tw, kind: 'water', idx: -1, point: o.clone().addScaledVector(d, tw), normal: new THREE.Vector3(0, 1, 0) };
    }
    if (ignoreBuildings) return best;
    const lim2 = best ? best.t : maxT;
    const end = o.clone().addScaledVector(d, lim2);
    const set = new Set<number>();
    this.query(this.buckets, o.x, o.z, end.x, end.z, set);
    for (const i of set) {
      const b = this.map.buildings[i];
      if (b.destroyed) continue;
      const t = rayOBB(o, d, b, lim2);
      if (t !== null && (!best || t.t < best.t)) best = { t: t.t, kind: 'building', idx: i, point: o.clone().addScaledVector(d, t.t), normal: t.n };
    }
    return best;
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = b.clone().sub(a);
    const len = d.length();
    d.divideScalar(len);
    const h = this.raycast(a, d, len - 2);
    return !h;
  }

  /** Apply damage to a building; returns true if it was destroyed by this hit. */
  damageBuilding(i: number, dmg: number): boolean {
    const b = this.map.buildings[i];
    if (!b || b.destroyed || b.indestructible) return false;
    b.hp -= dmg;
    return b.hp <= 0;
  }

  destroyBuilding(i: number) {
    const b = this.map.buildings[i];
    if (!b || b.destroyed) return;
    b.destroyed = true; b.hp = 0;
    const inst = this.instanced.get(i);
    if (inst) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(b.x, b.y - 0.3, b.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot), new THREE.Vector3(b.w, b.h * 0.18, b.d));
      inst.mesh.setMatrixAt(inst.i, m);
      inst.mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    const mesh = this.buildingMeshes.get(i) as THREE.Mesh | undefined;
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = rubbleGeometry(b);
      mesh.castShadow = false;
    }
    this.scorch(b.x, b.z, Math.max(b.w, b.d) * 0.7);
  }

  knockTree(i: number, dir: number) {
    const t = this.map.trees[i];
    if (!t || t.fallen || !this.treeMeshes) return;
    t.fallen = true;
    this.treeMeshes.setMatrixAt(i, this.treeMatrix(t.x, t.y, t.z, t.s, t.rot, true, dir));
    this.treeMeshes.instanceMatrix.needsUpdate = true;
  }

  clampToBounds(p: THREE.Vector3): boolean {
    let hit = false;
    const lim = PLAY + 10;
    if (p.x > lim) { p.x = lim; hit = true; } if (p.x < -lim) { p.x = -lim; hit = true; }
    if (p.z > lim) { p.z = lim; hit = true; } if (p.z < -lim) { p.z = -lim; hit = true; }
    return hit;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.groundTex?.dispose();
  }
}

function rayOBB(o: THREE.Vector3, d: THREE.Vector3, b: Building, maxT: number): { t: number; n: THREE.Vector3 } | null {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const ox = o.x - b.x, oz = o.z - b.z;
  const lo = [ox * c - oz * s, o.y - b.y - b.h / 2 + 0.5, ox * s + oz * c];
  const ld = [d.x * c - d.z * s, d.y, d.x * s + d.z * c];
  const hs = [b.w / 2, b.h / 2 + 0.5, b.d / 2];
  let tmin = 0, tmax = maxT, axis = -1, sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-9) { if (lo[i] < -hs[i] || lo[i] > hs[i]) return null; continue; }
    let t1 = (-hs[i] - lo[i]) / ld[i], t2 = (hs[i] - lo[i]) / ld[i];
    let sg = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = sg; }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (axis < 0) return { t: 0, n: new THREE.Vector3(0, 1, 0) };
  const ln = [0, 0, 0]; ln[axis] = sign;
  const n = new THREE.Vector3(ln[0] * c + ln[2] * s, ln[1], -ln[0] * s + ln[2] * c);
  return { t: tmin, n };
}

function makeDetailTexture(): THREE.DataTexture {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // tileable noise via wrapped value noise
    const n1 = tileNoise(x, y, S, 16, 1), n2 = tileNoise(x, y, S, 4, 2);
    data[i] = Math.max(0, Math.min(255, (n1 * 0.6 + Math.random() * 0.4) * 255));
    data[i + 1] = n2 * 255; data[i + 2] = 128; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function tileNoise(x: number, y: number, S: number, cells: number, seed: number): number {
  const fx = (x / S) * cells, fy = (y / S) * cells;
  const xi = Math.floor(fx), yi = Math.floor(fy);
  const h = (a: number, b: number) => {
    const aa = ((a % cells) + cells) % cells, bb = ((b % cells) + cells) % cells;
    let v = (aa * 374761393 + bb * 668265263 + seed * 1442695041) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const u = fx - xi, v = fy - yi;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}
