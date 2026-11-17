import { getMap, type MapDef } from '../data/maps';
import { fbm, mulberry32, ridge, type RNG } from './noise';

export const WORLD = 1400;
export const HALF = WORLD / 2;
export const PLAY = 520; // playable half-extent
export const GRID = 256;
export const CELL = WORLD / GRID;

export type BType = 'house' | 'flat' | 'ruin' | 'church' | 'factory' | 'barn' | 'izba' | 'hedge' | 'wall' | 'rock' | 'station' | 'chimney' | 'fortwall';

export interface Building {
  idx: number; type: BType; x: number; z: number; y: number; w: number; d: number; h: number; rot: number;
  color: number; roof: number; hp: number; maxHp: number; destroyed: boolean; instanced: boolean; indestructible: boolean;
}
export interface TreeInst { idx: number; x: number; z: number; y: number; s: number; rot: number; fallen: boolean; }
export interface Road { pts: [number, number][]; w: number; rail?: boolean; }
export interface Field { x: number; z: number; w: number; d: number; rot: number; color: number; }
export interface CapturePoint { name: string; x: number; z: number; r: number; }
export interface Spawn { x: number; z: number; yaw: number; }

export interface MapData {
  def: MapDef; seed: number;
  heights: Float32Array;
  roads: Road[]; buildings: Building[]; trees: TreeInst[]; fields: Field[];
  points: CapturePoint[]; spawns: [Spawn[], Spawn[]]; water: number | null;
  oasis?: { x: number; z: number; r: number };
}

const BHP: Record<BType, number> = {
  house: 420, flat: 380, ruin: 260, church: 900, factory: 2400, barn: 260, izba: 180, hedge: 70, wall: 120, rock: 1e9, station: 1200, chimney: 700, fortwall: 600,
};

class Gen {
  h: Float32Array;
  roads: Road[] = [];
  buildings: Building[] = [];
  trees: TreeInst[] = [];
  fields: Field[] = [];
  occupied: { x: number; z: number; r: number }[] = [];
  constructor(public def: MapDef, public rng: RNG, public seed: number) {
    this.h = new Float32Array((GRID + 1) * (GRID + 1));
  }
  idx(i: number, j: number) { return j * (GRID + 1) + i; }
  forEachVertex(fn: (x: number, z: number, k: number) => void) {
    for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) fn(-HALF + i * CELL, -HALF + j * CELL, this.idx(i, j));
  }
  height(x: number, z: number): number { return sampleGrid(this.h, x, z); }
  r(a: number, b: number) { return a + this.rng() * (b - a); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.rng() * arr.length)]; }

  road(pts: [number, number][], w = 7, rail = false) { this.roads.push({ pts, w, rail }); }
  distRoad(x: number, z: number): number {
    let best = 1e9;
    for (const rd of this.roads) for (let i = 0; i < rd.pts.length - 1; i++) {
      const d = distSeg(x, z, rd.pts[i], rd.pts[i + 1]) - rd.w / 2;
      if (d < best) best = d;
    }
    return best;
  }
  free(x: number, z: number, r: number): boolean {
    if (Math.abs(x) > HALF - 20 || Math.abs(z) > HALF - 20) return false;
    for (const o of this.occupied) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + r) ** 2) return false;
    return true;
  }
  /** Flatten terrain under a rectangle. */
  flatten(x: number, z: number, w: number, d: number, rot: number, margin = 4): number {
    const c = Math.cos(rot), s = Math.sin(rot);
    let sum = 0, n = 0;
    for (const [ox, oz] of [[0, 0], [w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
      sum += this.height(x + ox * c + oz * s, z - ox * s + oz * c); n++;
    }
    const target = sum / n;
    const R = Math.max(w, d) / 2 + margin + CELL;
    const i0 = Math.max(0, Math.floor((x - R + HALF) / CELL)), i1 = Math.min(GRID, Math.ceil((x + R + HALF) / CELL));
    const j0 = Math.max(0, Math.floor((z - R + HALF) / CELL)), j1 = Math.min(GRID, Math.ceil((z + R + HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const vx = -HALF + i * CELL - x, vz = -HALF + j * CELL - z;
      const lx = vx * c - vz * s, lz = vx * s + vz * c;
      const ex = Math.max(0, Math.abs(lx) - w / 2), ez = Math.max(0, Math.abs(lz) - d / 2);
      const e = Math.sqrt(ex * ex + ez * ez);
      const k = this.idx(i, j);
      const t = e <= 0 ? 1 : Math.max(0, 1 - e / (margin + CELL));
      this.h[k] = this.h[k] * (1 - t) + target * t;
    }
    return target;
  }
  building(type: BType, x: number, z: number, w: number, d: number, h: number, rot: number, color: number, roof = 0x6a3a2a, occupy = true): Building | null {
    const r = Math.sqrt(w * w + d * d) / 2;
    if (occupy && !this.free(x, z, r * 0.9)) return null;
    const instanced = type === 'hedge' || type === 'wall' || type === 'rock';
    const y = instanced ? this.height(x, z) : this.flatten(x, z, w, d, rot, type === 'factory' ? 6 : 3);
    const b: Building = { idx: this.buildings.length, type, x, z, y, w, d, h, rot, color, roof, hp: BHP[type], maxHp: BHP[type], destroyed: false, instanced, indestructible: type === 'rock' };
    this.buildings.push(b);
    if (occupy) this.occupied.push({ x, z, r: instanced ? Math.min(w, d) / 2 : r });
    return b;
  }
  tree(x: number, z: number, s: number) {
    if (Math.abs(x) > HALF - 10 || Math.abs(z) > HALF - 10) return;
    for (const o of this.occupied) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + 1.5) ** 2) return;
    if (this.distRoad(x, z) < 2.5) return;
    this.trees.push({ idx: this.trees.length, x, z, y: 0, s, rot: this.rng() * Math.PI * 2, fallen: false });
  }
  forest(cx: number, cz: number, r: number, n: number, smin = 0.8, smax = 1.3) {
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2, d = Math.sqrt(this.rng()) * r;
      this.tree(cx + Math.cos(a) * d, cz + Math.sin(a) * d, this.r(smin, smax));
    }
  }
  /** Buildings lining both sides of a road segment. */
  street(a: [number, number], b: [number, number], spacing: number, setback: number, make: (x: number, z: number, rot: number, side: number) => void, prob = 0.85) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const rot = Math.atan2(ux, uz);
    for (let t = spacing / 2; t < len; t += spacing) {
      for (const side of [1, -1]) {
        if (this.rng() > prob) continue;
        const x = a[0] + ux * t + uz * setback * side;
        const z = a[1] + uz * t - ux * setback * side;
        make(x, z, rot, side);
      }
    }
  }
  smoothRoads() {
    // blur heights near roads so they form usable lanes
    const copy = new Float32Array(this.h);
    this.forEachVertex((x, z, k) => {
      const d = this.distRoad(x, z);
      if (d > 6) return;
      const i = Math.round((x + HALF) / CELL), j = Math.round((z + HALF) / CELL);
      let s = 0, n = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = Math.min(GRID, Math.max(0, i + di)), jj = Math.min(GRID, Math.max(0, j + dj));
        s += copy[this.idx(ii, jj)]; n++;
      }
      const t = d < 0 ? 1 : 1 - d / 6;
      this.h[k] = copy[k] * (1 - t) + (s / n - (d < 0 ? 0.25 : 0)) * t;
    });
  }
  borders() {
    // raise terrain outside the playable area to form natural walls
    this.forEachVertex((x, z, k) => {
      const e = Math.max(Math.abs(x), Math.abs(z)) - PLAY;
      if (e > 0) this.h[k] += Math.pow(e / 40, 1.6) * 6 + fbm(x / 60, z / 60, this.seed + 9) * Math.min(1, e / 60) * 10;
    });
  }
}

export function sampleGrid(h: Float32Array, x: number, z: number): number {
  const fx = Math.min(GRID - 1e-4, Math.max(0, (x + HALF) / CELL));
  const fz = Math.min(GRID - 1e-4, Math.max(0, (z + HALF) / CELL));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * (GRID + 1) + i;
  const a = h[k], b = h[k + 1], c = h[k + GRID + 1], d = h[k + GRID + 2];
  // two triangles matching the rendered mesh (diagonal from (i,j+1) to (i+1,j))
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

function distSeg(x: number, z: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function wiggle(g: Gen, a: [number, number], b: [number, number], n: number, amp: number): [number, number][] {
  const pts: [number, number][] = [];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  const nx = -dz / len, nz = dx / len;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = i === 0 || i === n ? 0 : (g.rng() - 0.5) * 2 * amp;
    pts.push([a[0] + dx * t + nx * off, a[1] + dz * t + nz * off]);
  }
  return pts;
}

function gauss(x: number, z: number, cx: number, cz: number, r: number) {
  return Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (r * r));
}

const SPAWN_Z = 440;
function defaultSpawns(): [Spawn[], Spawn[]] {
  const a: Spawn[] = [], b: Spawn[] = [];
  for (let i = 0; i < 8; i++) {
    const x = (i - 3.5) * 28;
    a.push({ x, z: -SPAWN_Z, yaw: 0 });
    b.push({ x, z: SPAWN_Z, yaw: Math.PI });
  }
  return [a, b];
}

// ---------------------------------------------------------------- generators

function genNormandy(g: Gen) {
  const s = g.seed;
  g.forEachVertex((x, z, k) => { g.h[k] = fbm(x / 320, z / 320, s, 4) * 12 + fbm(x / 70, z / 70, s + 3, 2) * 1.5; });
  g.borders();
  const nsRoad = wiggle(g, [-20, -HALF], [10, HALF], 9, 18);
  const ewRoad = wiggle(g, [-HALF, 30], [HALF, -20], 9, 18);
  g.road(nsRoad, 7); g.road(ewRoad, 7);
  g.road(wiggle(g, [10, 20], [-320, -150], 5, 12), 5);
  g.road(wiggle(g, [10, 20], [330, 170], 5, 12), 5);
  g.smoothRoads();
  const stone = [0xb5a88e, 0xa89a80, 0xc2b59a, 0x9c907a];
  const roofs = [0x5a4a40, 0x4c4b4e, 0x6b3a2a, 0x575a5e];
  // village church
  g.building('church', 32, 52, 12, 24, 10, 0.05, 0xb8ab90, 0x4c4b4e);
  for (const seg of [nsRoad, ewRoad]) for (let i = 0; i < seg.length - 1; i++) {
    const m: [number, number] = [(seg[i][0] + seg[i + 1][0]) / 2, (seg[i][1] + seg[i + 1][1]) / 2];
    if (Math.hypot(m[0], m[1]) > 190) continue;
    g.street(seg[i], seg[i + 1], 17, 11, (x, z, rot) => {
      if (Math.hypot(x, z) > 170) return;
      g.building(g.rng() < 0.75 ? 'house' : 'barn', x, z, g.r(8, 12), g.r(9, 14), g.r(5, 8), rot, g.pick(stone), g.pick(roofs));
    });
  }
  // farms
  const farms: [number, number][] = [[-320, -150], [330, 170], [-260, 260], [250, -280]];
  for (const [fx, fz] of farms) {
    g.building('house', fx, fz, 10, 14, 7, g.r(0, 3), g.pick(stone), g.pick(roofs));
    g.building('barn', fx + 22, fz + 8, 12, 18, 7, g.r(0, 3), 0x8a6a4a, 0x5a4a40);
    g.building('barn', fx - 18, fz + 16, 9, 12, 5, g.r(0, 3), 0x9a8a70, 0x5a4a40);
    for (let i = 0; i < 4; i++) g.building('wall', fx + (i - 1.5) * 9, fz - 22, 9, 0.8, 1.6, 0, 0x9c907a, 0, true);
  }
  // spawn exclusion
  g.occupied.push({ x: 0, z: -SPAWN_Z, r: 70 }, { x: 0, z: SPAWN_Z, r: 70 });
  // bocage field grid
  const C = 92;
  for (let gx = -6; gx <= 6; gx++) for (let gz = -6; gz <= 6; gz++) {
    const x0 = gx * C + g.r(-8, 8), z0 = gz * C + g.r(-8, 8);
    if (Math.hypot(x0, z0) < 150) continue;
    if (Math.abs(x0) > PLAY - 20 || Math.abs(z0) > PLAY - 20) continue;
    g.fields.push({ x: x0 + C / 2, z: z0 + C / 2, w: C - 6, d: C - 6, rot: 0, color: g.pick(g.def.theme.field) });
    // hedges along two edges, split into pieces with a gate gap
    for (const horiz of [true, false]) {
      const pieces = 4;
      const gap = Math.floor(g.rng() * pieces);
      for (let p = 0; p < pieces; p++) {
        if (p === gap || g.rng() < 0.12) continue;
        const L = C / pieces;
        const cx = horiz ? x0 + L * (p + 0.5) : x0;
        const cz = horiz ? z0 : z0 + L * (p + 0.5);
        if (g.distRoad(cx, cz) < 10) continue;
        const b = g.building('hedge', cx, cz, horiz ? L : 3.2, horiz ? 3.2 : L, g.r(2.6, 3.6), 0, 0x3e5a24, 0, true);
        if (b && g.rng() < 0.5) g.tree(cx + g.r(-L / 2, L / 2) * (horiz ? 1 : 0), cz + g.r(-L / 2, L / 2) * (horiz ? 0 : 1), g.r(1.1, 1.6));
      }
    }
    // orchards
    if (g.rng() < 0.18) for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) g.tree(x0 + 15 + i * 15, z0 + 15 + j * 15, g.r(0.6, 0.8));
  }
  for (let i = 0; i < 10; i++) g.forest(g.r(-500, 500), g.r(-350, 350), g.r(25, 50), 25);
  return { points: [[-320, -150], [32, 30], [330, 170]] as [number, number][] };
}

function genStalingrad(g: Gen) {
  const s = g.seed;
  g.forEachVertex((x, z, k) => {
    let h = fbm(x / 250, z / 250, s, 3) * 2.5 + gauss(x, z, -290, 230, 130) * 24;
    if (x > 400) h -= Math.min(9, (x - 400) * 0.18);
    g.h[k] = h;
  });
  g.borders();
  // re-cut river after borders on the east side
  g.forEachVertex((x, z, k) => { if (x > 430 && Math.abs(z) < HALF) g.h[k] = Math.min(g.h[k], -4 - (x - 430) * 0.05); });
  // street grid
  const B = 64;
  for (let i = -7; i <= 7; i++) {
    const x = i * B;
    if (x < 400) g.road([[x, -PLAY], [x, PLAY]], 10);
  }
  for (let j = -7; j <= 7; j++) g.road([[-PLAY, j * B], [395, j * B]], 10);
  g.road([[-PLAY, -40], [380, -40]], 8, true);
  g.smoothRoads();
  g.occupied.push({ x: 0, z: -SPAWN_Z, r: 60 }, { x: 0, z: SPAWN_Z, r: 60 });
  g.occupied.push({ x: -290, z: 230, r: 90 });
  const walls = [0x8a8074, 0x9a8e80, 0x7c746a, 0xa49784, 0x6d665e];
  // landmarks
  g.building('station', -60, -60, 52, 16, 11, 0, 0xa89880, 0x4a4744, false);
  g.occupied.push({ x: -60, z: -60, r: 30 });
  for (let i = 0; i < 3; i++) g.building('factory', 230 + (i - 1) * 4, -210 + (i - 1) * 46, 70, 26, 15, 0, 0x8a6a58, 0x4a4744, false);
  g.occupied.push({ x: 230, z: -210, r: 75 });
  g.building('chimney', 290, -150, 4, 4, 34, 0, 0x7a4a3a, 0, false);
  g.building('chimney', 300, -270, 4, 4, 30, 0, 0x7a4a3a, 0, false);
  for (let i = -6; i <= 5; i++) for (let j = -6; j <= 6; j++) {
    const cx = i * B + B / 2, cz = j * B + B / 2;
    if (cx > 395) continue;
    if (g.rng() < 0.14) continue; // empty / rubble block
    const n = 2 + Math.floor(g.rng() * 3);
    for (let k = 0; k < n; k++) {
      const w = g.r(12, 26), d = g.r(10, 18);
      const ox = g.r(-B / 2 + 8 + w / 2, B / 2 - 8 - w / 2), oz = g.r(-B / 2 + 8 + d / 2, B / 2 - 8 - d / 2);
      const rot = g.rng() < 0.5 ? 0 : Math.PI / 2;
      g.building(g.rng() < 0.82 ? 'ruin' : 'flat', cx + ox, cz + oz, rot ? d : w, rot ? w : d, g.r(7, 19), 0, g.pick(walls), 0x4a4744);
    }
  }
  for (let i = 0; i < 70; i++) g.tree(g.r(-500, 380), g.r(-500, 500), g.r(0.7, 1.1));
  for (let i = 0; i < 40; i++) g.building('rock', g.r(-480, 380), g.r(-480, 480), g.r(2, 4), g.r(2, 4), g.r(0.8, 1.6), g.rng() * 3, 0x6a645c, 0, true);
  return { points: [[-290, 230], [-60, -30], [230, -210]] as [number, number][] };
}

function genKursk(g: Gen) {
  const s = g.seed;
  g.forEachVertex((x, z, k) => {
    g.h[k] = fbm(x / 420, z / 420, s, 4) * 26 + ridge(x / 300, z / 300, s + 4, 3) * 8 + gauss(x, z, 120, 110, 150) * 20 + fbm(x / 60, z / 60, s + 8, 2) * 0.8;
  });
  g.borders();
  const r1 = wiggle(g, [-HALF, -80], [HALF, -60], 10, 25);
  const r2 = wiggle(g, [-250, -HALF], [-150, HALF], 10, 30);
  g.road(r1, 6); g.road(r2, 6);
  g.road(wiggle(g, [-200, -70], [250, -150], 5, 20), 5);
  g.road([[-HALF, 200], [HALF, 260]], 7, true);
  g.smoothRoads();
  g.occupied.push({ x: 0, z: -SPAWN_Z, r: 70 }, { x: 0, z: SPAWN_Z, r: 70 });
  const wood = [0x7a5c3e, 0x6b5036, 0x8a6a48];
  const thatch = [0x8f7a4c, 0x7d6a40, 0x6a5a3a];
  // Prokhorovka village along the roads
  for (const seg of [r1, r2]) for (let i = 0; i < seg.length - 1; i++) {
    g.street(seg[i], seg[i + 1], 16, 12, (x, z, rot) => {
      if (Math.hypot(x + 230, z + 70) > 170) return;
      g.building('izba', x, z, g.r(6, 8), g.r(7, 10), g.r(3.5, 4.5), rot, g.pick(wood), g.pick(thatch));
    }, 0.8);
  }
  g.building('church', -200, -20, 11, 20, 9, 0.3, 0xd8d0c0, 0x3d6a5a);
  // sovkhoz
  for (let i = 0; i < 6; i++) g.building(i < 2 ? 'barn' : 'flat', 250 + (i % 3) * 26 - 26, -150 + Math.floor(i / 3) * 30 - 15, g.r(14, 22), g.r(9, 12), g.r(5, 7), 0.1, 0xb8ad98, 0x6a5a4a);
  // fields
  for (let i = 0; i < 40; i++) {
    const x = g.r(-500, 500), z = g.r(-500, 500);
    g.fields.push({ x, z, w: g.r(70, 160), d: g.r(60, 140), rot: g.r(-0.4, 0.4), color: g.pick(g.def.theme.field) });
  }
  for (let i = 0; i < 12; i++) g.forest(g.r(-500, 500), g.r(-420, 420), g.r(25, 60), 32, 0.9, 1.4);
  for (let i = 0; i < 25; i++) g.building('rock', g.r(-480, 480), g.r(-480, 480), g.r(1.5, 3), g.r(1.5, 3), g.r(0.6, 1.2), g.rng() * 3, 0x857f70, 0, true);
  return { points: [[-230, -70], [120, 110], [250, -150]] as [number, number][] };
}

function genAfrica(g: Gen) {
  const s = g.seed;
  g.forEachVertex((x, z, k) => {
    const mx = Math.max(0, Math.abs(x) - 330 - fbm(z / 200, x / 200, s + 2, 2) * 60);
    const mountain = Math.pow(mx / 120, 1.5) * 40 * (0.7 + ridge(x / 160, z / 160, s + 5, 4) * 0.8);
    const dunes = (Math.sin((x * 0.6 + z) / 38 + fbm(x / 120, z / 120, s, 2) * 4) * 0.5 + 0.5) * 4 * (0.5 + fbm(x / 300, z / 300, s + 1, 2));
    g.h[k] = mountain + dunes + fbm(x / 350, z / 350, s + 3, 3) * 8 + gauss(x, z, 0, 260, 90) * 16;
  });
  g.borders();
  const main = wiggle(g, [-60, -HALF], [40, HALF], 10, 30);
  g.road(main, 7);
  g.road(wiggle(g, [-120, -100], [180, 60], 4, 15), 5);
  g.road(wiggle(g, [0, 120], [0, 250], 3, 10), 5);
  g.smoothRoads();
  g.occupied.push({ x: 0, z: -SPAWN_Z, r: 70 }, { x: 0, z: SPAWN_Z, r: 70 });
  const walls = [0xe8e0cc, 0xd8ccb0, 0xc9b89a, 0xf0ead8];
  for (let i = 0; i < 26; i++) {
    const a = g.rng() * Math.PI * 2, d = Math.sqrt(g.rng()) * 90;
    const x = -120 + Math.cos(a) * d, z = -100 + Math.sin(a) * d;
    if (g.distRoad(x, z) < 6) continue;
    g.building('flat', x, z, g.r(7, 13), g.r(7, 13), g.r(3.5, 6.5), g.rng() < 0.5 ? 0 : Math.PI / 4, g.pick(walls), 0);
  }
  // Djebel fort on the hill
  const fy = 260;
  for (const [dx, dz, w, d] of [[0, -22, 44, 3], [0, 22, 44, 3], [-22, 0, 3, 44], [22, 0, 3, 44]] as [number, number, number, number][]) {
    if (dz === -22) {
      g.building('fortwall', dx - 14, fy + dz, 16, d, 5, 0, 0xb09a78, 0, false);
      g.building('fortwall', dx + 14, fy + dz, 16, d, 5, 0, 0xb09a78, 0, false);
    } else g.building('fortwall', dx, fy + dz, w, d, 5, 0, 0xb09a78, 0, false);
  }
  g.occupied.push({ x: 0, z: fy, r: 26 });
  // oasis
  for (let i = 0; i < 45; i++) { const a = g.rng() * Math.PI * 2, d = Math.sqrt(g.rng()) * 55; g.tree(180 + Math.cos(a) * d, 60 + Math.sin(a) * d, g.r(0.9, 1.3)); }
  for (let i = 0; i < 40; i++) g.tree(g.r(-300, 300), g.r(-450, 450), g.r(0.8, 1.2));
  for (let i = 0; i < 90; i++) g.building('rock', g.r(-420, 420), g.r(-500, 500), g.r(2, 6), g.r(2, 6), g.r(1, 3), g.rng() * 3, 0x9a8064, 0, true);
  return { points: [[-120, -100], [180, 60], [0, 260]] as [number, number][], oasis: { x: 180, z: 60, r: 60 } };
}

export function generateMap(mapId: string, seed: number): MapData {
  const def = getMap(mapId);
  const g = new Gen(def, mulberry32(seed), seed);
  let res: { points: [number, number][]; oasis?: { x: number; z: number; r: number } };
  switch (def.id) {
    case 'stalingrad': res = genStalingrad(g); break;
    case 'kursk': res = genKursk(g); break;
    case 'africa': res = genAfrica(g); break;
    default: res = genNormandy(g);
  }
  for (const b of g.buildings) if (b.instanced) b.y = g.height(b.x, b.z);
  for (const t of g.trees) t.y = g.height(t.x, t.z);
  const points = res.points.map(([x, z], i) => ({ name: def.pointNames[i], x, z, r: 32 }));
  // spawns sit on flat-ish ground
  const spawns = defaultSpawns();
  return {
    def, seed, heights: g.h, roads: g.roads, buildings: g.buildings, trees: g.trees, fields: g.fields, points, spawns,
    water: def.id === 'stalingrad' ? -1.6 : null, oasis: res.oasis,
  };
}
