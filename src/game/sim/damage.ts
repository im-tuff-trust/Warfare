import * as THREE from 'three';
import { AMMO, penAt, normalizationOf, ricochetAngleOf, type AmmoSpec } from '../data/ammo';
import { ROLE_NAMES, type Role, type TankSpec } from '../data/vehicles';
import { rayBox, rayConvex, raySphere } from './geometry';
import { dirHullToTurret, dirTurretToHull, getLayout, hullToTurret, turretToHull, type ModuleType, type TankLayout } from './layout';

// ---------------------------------------------------------------- state

export interface DamageState {
  crew: number[]; // hp per seat 0..100
  modules: number[]; // hp per module
  rounds: number[]; // rounds left per module (ammo racks), 0 otherwise
  structure: number;
  maxStructure: number;
  fire: number; // seconds the vehicle has been burning, 0 = no fire
  fireCause: string;
  extinguishers: number;
  medkits: number;
  destroyed: boolean;
  detonated: boolean;
  repairing: number; // seconds remaining on field repair, 0 = idle
  extinguishing: number;
  lastHitTime: number;
}

export function newDamageState(spec: TankSpec): DamageState {
  const lay = getLayout(spec);
  return {
    crew: lay.seats.map(() => 100),
    modules: lay.modules.map((m) => m.maxHp),
    rounds: lay.modules.map((m) => m.rounds ?? 0),
    structure: spec.structure, maxStructure: spec.structure,
    fire: 0, fireCause: '', extinguishers: 2, medkits: 1,
    destroyed: false, detonated: false, repairing: 0, extinguishing: 0, lastHitTime: 0,
  };
}

// ---------------------------------------------------------------- crew efficiency

export interface RoleStatus { eff: number; seat: number; substitute: boolean; }

export function crewEff(hp: number): number {
  return hp <= 0 ? 0 : 0.35 + 0.65 * (hp / 100);
}

/** How well a role is being performed (0..1), with substitution if its crewman is down. */
export function roleStatus(spec: TankSpec, st: DamageState, role: Role): RoleStatus {
  const lay = getLayout(spec);
  const seat = lay.seats.find((s) => s.roles.includes(role));
  if (seat && st.crew[seat.idx] > 0) return { eff: crewEff(st.crew[seat.idx]), seat: seat.idx, substitute: false };
  // substitute: best surviving crewman takes over the job at reduced efficiency
  let best = -1, bestHp = 0;
  lay.seats.forEach((s, i) => {
    if (st.crew[i] > bestHp && !(role !== 'driver' && s.roles.includes('driver') && lay.seats.length > 2)) { best = i; bestHp = st.crew[i]; }
  });
  if (best < 0) return { eff: 0, seat: -1, substitute: true };
  return { eff: crewEff(bestHp) * 0.45, seat: best, substitute: true };
}

export function aliveCrew(st: DamageState): number {
  return st.crew.filter((h) => h > 0).length;
}

export function moduleHp(spec: TankSpec, st: DamageState, type: ModuleType): number {
  const lay = getLayout(spec);
  const m = lay.modules.find((x) => x.type === type);
  return m ? st.modules[m.idx] / m.maxHp : 1;
}

export function totalRounds(st: DamageState): number {
  return st.rounds.reduce((a, b) => a + b, 0);
}

export function crewStatusLabel(hp: number): string {
  if (hp <= 0) return 'KIA';
  if (hp >= 100) return 'Healthy';
  if (hp > 66) return 'Light wound';
  if (hp > 33) return 'Wounded';
  return 'Critical';
}

/** Derived gameplay modifiers from crew and modules. */
export interface TankModifiers {
  traverse: number; aimTime: number; dispersion: number; reload: number; mobility: number; steering: number;
  power: number; maxSpeed: number; spotting: number; radio: number; canFire: boolean; canMove: boolean;
  trackL: boolean; trackR: boolean;
}

export function tankModifiers(spec: TankSpec, st: DamageState): TankModifiers {
  const g = roleStatus(spec, st, 'gunner');
  const l = roleStatus(spec, st, 'loader');
  const d = roleStatus(spec, st, 'driver');
  const c = roleStatus(spec, st, 'commander');
  const r = roleStatus(spec, st, 'radio');
  const engine = moduleHp(spec, st, 'engine');
  const trans = moduleHp(spec, st, 'transmission');
  const drive = moduleHp(spec, st, 'turretDrive');
  const breech = moduleHp(spec, st, 'breech');
  const barrel = moduleHp(spec, st, 'barrel');
  const radioM = moduleHp(spec, st, 'radio');
  const tl = moduleHp(spec, st, 'trackL') > 0, tr = moduleHp(spec, st, 'trackR') > 0;
  const ammoDamaged = getLayout(spec).modules.some((m) => m.type === 'ammo' && st.modules[m.idx] < m.maxHp);
  return {
    traverse: (0.3 + 0.7 * g.eff) * (drive <= 0 ? 0.12 : drive < 0.5 ? 0.6 : 1),
    aimTime: 1 / Math.max(0.15, g.eff),
    dispersion: (1 + (1 - g.eff) * 1.6) * (barrel < 0.5 ? 1.7 : 1),
    reload: (1 / Math.max(0.12, 0.45 + 0.55 * l.eff)) * (ammoDamaged ? 1.25 : 1) * (breech < 0.5 ? 1.3 : 1),
    mobility: 0.4 + 0.6 * d.eff,
    steering: 0.35 + 0.65 * d.eff,
    power: engine <= 0 ? 0 : engine < 0.5 ? 0.5 : 1,
    maxSpeed: trans <= 0 ? 0 : trans < 0.5 ? 0.6 : 1,
    spotting: 0.45 + 0.55 * c.eff,
    radio: radioM <= 0 ? 0 : (0.2 + 0.8 * r.eff) * (radioM < 0.5 ? 0.6 : 1),
    canFire: breech > 0 && barrel > 0 && g.eff > 0 && st.rounds.some((x) => x > 0),
    canMove: d.eff > 0 && engine > 0 && trans > 0 && tl && tr,
    trackL: tl, trackR: tr,
  };
}

// ---------------------------------------------------------------- hit reports

export type HitResult = 'ricochet' | 'nonpen' | 'partial' | 'pen' | 'module' | 'blast';
export type Severity = 'none' | 'light' | 'moderate' | 'severe' | 'critical' | 'destroyed';

export interface CrewHit { seat: number; roles: Role[]; dmg: number; hpAfter: number; status: string; }
export interface ModuleHit { idx: number; name: string; type: ModuleType; dmg: number; hpAfter: number; state: 'damaged' | 'destroyed'; }

export interface HitReport {
  time: number;
  shooter: string; target: string; shooterName: string; targetName: string; vehicleId: string;
  ammoId: string; ammoName: string;
  result: HitResult;
  section: string; thickness: number; angle: number; effective: number; pen: number; distance: number;
  point: [number, number, number]; // hull-local impact
  dir: [number, number, number];
  onTurret: boolean; turretYaw: number;
  rays: number[]; // flattened segments x1,y1,z1,x2,y2,z2 (hull local)
  shellPath: number[];
  modulesHit: ModuleHit[];
  crewHit: CrewHit[];
  fire: boolean; ammoDamaged: boolean; ammoDetonation: boolean; destroyed: boolean;
  structureDmg: number; severity: Severity;
  summary: string;
}

const SECTION_NAMES: Record<string, string> = {
  floor: 'Hull floor', lowerFront: 'Lower front hull', upperFront: 'Upper front hull', roof: 'Hull roof',
  upperRear: 'Upper rear hull', lowerRear: 'Lower rear hull', left: 'Left hull side', right: 'Right hull side',
  turretFront: 'Turret front', turretSide: 'Turret side', turretRear: 'Turret rear', turretRoof: 'Turret roof',
  turretRing: 'Turret ring', mantlet: 'Gun mantlet', barrel: 'Gun barrel', trackL: 'Left track & running gear', trackR: 'Right track & running gear',
};

function armorFor(spec: TankSpec, face: string): number {
  const a = spec.armor;
  switch (face) {
    case 'floor': return a.floor;
    case 'lowerFront': return a.lowerFront;
    case 'upperFront': return a.upperFront;
    case 'roof': return a.roof;
    case 'upperRear': case 'lowerRear': return a.rear;
    case 'left': case 'right': return a.side;
    case 'turretFront': return a.turretFront;
    case 'mantlet': return a.mantlet;
    case 'turretSide': return a.turretSide;
    case 'turretRear': return a.turretRear;
    case 'turretRoof': return a.turretRoof;
    case 'turretRing': return a.roof + 10;
    case 'trackL': case 'trackR': return a.side + 15;
    default: return a.side;
  }
}

export interface ShotInput {
  o: THREE.Vector3; // ray origin, hull local (slightly outside the vehicle)
  d: THREE.Vector3; // normalized direction, hull local
  ammo: AmmoSpec;
  dist: number;
  turretYaw: number; gunPitch: number;
  time: number;
  shooter: string; shooterName: string; target: string; targetName: string;
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/** Intersect a hull-local ray with the tank. */
export function intersectTank(spec: TankSpec, o: THREE.Vector3, d: THREE.Vector3, turretYaw: number, gunPitch: number, maxT = 100):
  { t: number; part: 'hull' | 'turret' | 'barrel'; face: string; n: THREE.Vector3; localP: THREE.Vector3 } | null {
  const lay = getLayout(spec);
  let best: { t: number; part: 'hull' | 'turret' | 'barrel'; face: string; n: THREE.Vector3; localP: THREE.Vector3 } | null = null;
  const hh = rayConvex(o, d, lay.hull, maxT);
  if (hh) best = { t: hh.t, part: 'hull', face: hh.plane.face, n: hh.plane.n.clone(), localP: o.clone().addScaledVector(d, hh.t) };
  const to = hullToTurret(o, turretYaw, lay.turretBase, _v);
  const td = dirHullToTurret(d, turretYaw, _v2);
  const th = rayConvex(to, td, lay.turret, maxT);
  if (th && (!best || th.t < best.t)) {
    best = { t: th.t, part: 'turret', face: th.plane.face, n: dirTurretToHull(th.plane.n, turretYaw, new THREE.Vector3()), localP: to.clone().addScaledVector(td, th.t) };
  }
  // barrel: transform into gun frame (rotate about X around trunnion)
  const tr = lay.trunnion;
  const c = Math.cos(gunPitch), s = Math.sin(gunPitch);
  const gx = to.x - tr.x, gy = to.y - tr.y, gz = to.z - tr.z;
  const go = _v3.set(gx, gy * c - gz * s, gy * s + gz * c);
  const gd = new THREE.Vector3(td.x, td.y * c - td.z * s, td.y * s + td.z * c);
  const bt = rayBox(go, gd, new THREE.Vector3(0, 0, spec.gun.length / 2 + 0.25), new THREE.Vector3(0.09 + spec.gun.caliber / 2000, 0.09 + spec.gun.caliber / 2000, spec.gun.length / 2), maxT);
  if (bt !== null && (!best || bt < best.t)) best = { t: bt, part: 'barrel', face: 'barrel', n: d.clone().negate(), localP: new THREE.Vector3() };
  return best;
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }

function randomCone(dir: THREE.Vector3, halfAngleDeg: number): THREE.Vector3 {
  const a = (halfAngleDeg * Math.PI) / 180;
  const cosA = 1 - Math.random() * (1 - Math.cos(a));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const phi = Math.random() * Math.PI * 2;
  const up = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, up).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u);
  return dir.clone().multiplyScalar(cosA).addScaledVector(u, Math.cos(phi) * sinA).addScaledVector(v, Math.sin(phi) * sinA).normalize();
}

interface Target { kind: 'crew' | 'module'; idx: number; c: THREE.Vector3; h?: THREE.Vector3; r?: number; }

function internalTargets(spec: TankSpec, st: DamageState, lay: TankLayout, turretYaw: number): Target[] {
  const out: Target[] = [];
  lay.seats.forEach((s, i) => {
    if (st.crew[i] <= 0) return;
    out.push({ kind: 'crew', idx: i, c: s.inTurret ? turretToHull(s.pos, turretYaw, lay.turretBase) : s.pos.clone(), r: s.r });
  });
  lay.modules.forEach((m, i) => {
    if (m.type === 'trackL' || m.type === 'trackR' || m.type === 'barrel') return;
    if (m.inTurret) {
      const c = turretToHull(m.c, turretYaw, lay.turretBase);
      // rotated boxes approximated by an axis-aligned box of the same volume
      const cy = Math.abs(Math.cos(turretYaw)), sy = Math.abs(Math.sin(turretYaw));
      out.push({ kind: 'module', idx: i, c, h: new THREE.Vector3(m.h.x * cy + m.h.z * sy, m.h.y, m.h.x * sy + m.h.z * cy) });
    } else out.push({ kind: 'module', idx: i, c: m.c.clone(), h: m.h.clone() });
  });
  return out;
}

class DamageCtx {
  crew = new Map<number, number>();
  mods = new Map<number, number>();
  rays: number[] = [];
  fire = false; ammoDamaged = false; ammoDet = false;
  constructor(public spec: TankSpec, public st: DamageState, public lay: TankLayout, public ammo: AmmoSpec, public targets: Target[]) {}
  addCrew(i: number, dmg: number) { this.crew.set(i, (this.crew.get(i) ?? 0) + dmg); }
  addMod(i: number, dmg: number) { this.mods.set(i, (this.mods.get(i) ?? 0) + dmg); }
  /** Trace a fragment; it stops on the first object hit (or passes through up to `pierce` objects). */
  frag(o: THREE.Vector3, d: THREE.Vector3, range: number, dmg: number, pierce = 1) {
    const hits: { t: number; tg: Target }[] = [];
    for (const tg of this.targets) {
      const t = tg.kind === 'crew' ? raySphere(o, d, tg.c, tg.r!, range) : rayBox(o, d, tg.c, tg.h!, range);
      if (t !== null) hits.push({ t, tg });
    }
    hits.sort((a, b) => a.t - b.t);
    let end = range;
    let energy = dmg;
    let n = 0;
    for (const h of hits) {
      if (n >= pierce || energy < 3) { end = h.t; break; }
      const falloff = 1 - Math.min(0.6, h.t / (range * 1.6));
      const dd = energy * falloff;
      if (h.tg.kind === 'crew') this.addCrew(h.tg.idx, dd);
      else {
        const m = this.lay.modules[h.tg.idx];
        this.addMod(h.tg.idx, dd * (m.type === 'engine' || m.type === 'transmission' ? 0.8 : 1));
      }
      energy *= h.tg.kind === 'crew' ? 0.35 : 0.5;
      n++;
      end = h.t;
    }
    this.rays.push(o.x, o.y, o.z, o.x + d.x * end, o.y + d.y * end, o.z + d.z * end);
  }
}

function applyCtx(ctx: DamageCtx, rep: HitReport) {
  const { spec, st, lay } = ctx;
  const diesel = spec.layout.diesel;
  ctx.mods.forEach((dmg, i) => {
    const m = lay.modules[i];
    const before = st.modules[i];
    if (before <= 0 && m.type !== 'ammo') return;
    const after = Math.max(0, before - dmg);
    st.modules[i] = after;
    rep.modulesHit.push({ idx: i, name: m.name, type: m.type, dmg: Math.round(dmg), hpAfter: Math.round(after), state: after <= 0 ? 'destroyed' : 'damaged' });
    if (m.type === 'ammo' && st.rounds[i] > 0) {
      ctx.ammoDamaged = true;
      if (after <= 0) {
        const detChance = ctx.ammo.kind === 'APHE' || ctx.ammo.kind === 'HE' ? 0.38 : 0.24;
        if (Math.random() < detChance * Math.min(1, 0.4 + st.rounds[i] / 60)) ctx.ammoDet = true;
        else { st.rounds[i] = 0; if (Math.random() < 0.6) ctx.fire = true; }
      } else {
        st.rounds[i] = Math.max(0, Math.floor(st.rounds[i] * (after / m.maxHp + 0.3)));
        if (Math.random() < 0.18) ctx.fire = true;
      }
    }
    if (m.type === 'fuel' && Math.random() < (diesel ? 0.14 : 0.4)) ctx.fire = true;
    if (m.type === 'engine' && Math.random() < (diesel ? 0.06 : 0.16)) ctx.fire = true;
  });
  ctx.crew.forEach((dmg, i) => {
    const before = st.crew[i];
    if (before <= 0) return;
    const after = Math.max(0, Math.round(before - dmg));
    st.crew[i] = after;
    rep.crewHit.push({ seat: i, roles: lay.seats[i].roles, dmg: Math.round(Math.min(before, dmg)), hpAfter: after, status: crewStatusLabel(after) });
  });
  rep.rays = ctx.rays.map((x) => Math.round(x * 100) / 100);
}

function finishReport(spec: TankSpec, st: DamageState, rep: HitReport, ctx: DamageCtx | null, structureDmg: number) {
  if (ctx) {
    applyCtx(ctx, rep);
    rep.ammoDamaged = ctx.ammoDamaged;
    if (ctx.fire && st.fire <= 0) { st.fire = 0.01; st.fireCause = rep.modulesHit.find((m) => m.type === 'fuel') ? 'fuel tank' : rep.modulesHit.find((m) => m.type === 'ammo') ? 'ammunition' : 'engine'; rep.fire = true; }
    if (ctx.ammoDet) { rep.ammoDetonation = true; st.detonated = true; st.crew = st.crew.map(() => 0); st.structure = 0; }
  }
  st.structure = Math.max(0, st.structure - structureDmg);
  rep.structureDmg = Math.round(structureDmg);
  checkDestroyed(spec, st);
  rep.destroyed = st.destroyed;
  const crewDmg = rep.crewHit.reduce((a, c) => a + c.dmg, 0);
  const killed = rep.crewHit.filter((c) => c.hpAfter <= 0).length;
  const modDest = rep.modulesHit.filter((m) => m.state === 'destroyed').length;
  const score = structureDmg + crewDmg * 0.6 + killed * 40 + modDest * 20 + (rep.fire ? 25 : 0);
  rep.severity = rep.destroyed ? 'destroyed' : score <= 0 ? 'none' : score < 15 ? 'light' : score < 45 ? 'moderate' : score < 90 ? 'severe' : 'critical';
  rep.summary = buildSummary(rep);
}

export function checkDestroyed(spec: TankSpec, st: DamageState) {
  if (st.destroyed) return;
  const alive = aliveCrew(st);
  const minCrew = spec.crew.length >= 4 ? 2 : 1;
  if (st.structure <= 0 || st.detonated || alive < minCrew) {
    st.destroyed = true;
    st.fire = st.fire || 0.01;
  }
}

function buildSummary(r: HitReport): string {
  const parts: string[] = [];
  const res: Record<HitResult, string> = { ricochet: 'Ricochet', nonpen: 'Non-penetration', partial: 'Partial penetration', pen: 'Penetration', module: 'Component hit', blast: 'Blast damage' };
  parts.push(res[r.result]);
  if (r.ammoDetonation) parts.push('AMMO DETONATION');
  else if (r.ammoDamaged) parts.push('ammo rack damaged');
  if (r.fire) parts.push('FIRE');
  const dest = r.modulesHit.filter((m) => m.state === 'destroyed').map((m) => m.name.toLowerCase());
  if (dest.length) parts.push(dest.join(', ') + ' destroyed');
  const ko = r.crewHit.filter((c) => c.hpAfter <= 0).map((c) => ROLE_NAMES[c.roles[0]].toLowerCase());
  if (ko.length) parts.push(ko.join(', ') + ' knocked out');
  const inj = r.crewHit.filter((c) => c.hpAfter > 0).length;
  if (inj) parts.push(`${inj} crew wounded`);
  return parts.join(' · ');
}

function baseReport(spec: TankSpec, inp: ShotInput, part: string): HitReport {
  return {
    time: inp.time, shooter: inp.shooter, target: inp.target, shooterName: inp.shooterName, targetName: inp.targetName, vehicleId: spec.id,
    ammoId: inp.ammo.id, ammoName: inp.ammo.name, result: 'nonpen', section: SECTION_NAMES[part] ?? part, thickness: 0, angle: 0, effective: 0,
    pen: 0, distance: Math.round(inp.dist), point: [0, 0, 0], dir: [inp.d.x, inp.d.y, inp.d.z], onTurret: false, turretYaw: inp.turretYaw,
    rays: [], shellPath: [], modulesHit: [], crewHit: [], fire: false, ammoDamaged: false, ammoDetonation: false, destroyed: false, structureDmg: 0, severity: 'none', summary: '',
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Resolve a projectile impact on a tank. Mutates the damage state and returns a full hit report. */
export function resolveShot(spec: TankSpec, st: DamageState, inp: ShotInput): HitReport | null {
  if (st.destroyed) return null;
  const lay = getLayout(spec);
  const hit = intersectTank(spec, inp.o, inp.d, inp.turretYaw, inp.gunPitch, 200);
  if (!hit) return null;
  const a = inp.ammo;
  const P = inp.o.clone().addScaledVector(inp.d, hit.t);
  let face = hit.face;
  if (hit.part === 'hull' && (face === 'left' || face === 'right') && P.y < spec.hull.trackTop) face = face === 'left' ? 'trackL' : 'trackR';
  if (hit.part === 'turret' && face === 'turretFront') {
    const lp = hit.localP;
    if (Math.abs(lp.x) < spec.turret.mantletW / 2 && Math.abs(lp.y - spec.turret.gunY) < 0.38) face = 'mantlet';
  }
  const rep = baseReport(spec, inp, face);
  rep.point = [r2(P.x), r2(P.y), r2(P.z)];
  rep.onTurret = hit.part !== 'hull';
  st.lastHitTime = inp.time;

  const isBlastAmmo = a.kind === 'HE' || a.kind === 'ROCKET';
  const ctxTargets = internalTargets(spec, st, lay, inp.turretYaw);

  // Barrel hit: damage the gun, no penetration
  if (hit.part === 'barrel') {
    const ctx = new DamageCtx(spec, st, lay, a, ctxTargets);
    const bi = lay.modules.findIndex((m) => m.type === 'barrel');
    ctx.addMod(bi, Math.min(100, a.caliber * (isBlastAmmo ? 1.2 : 0.9) + a.explosive * 40));
    rep.result = 'module';
    rep.section = SECTION_NAMES.barrel;
    finishReport(spec, st, rep, ctx, a.damage * 0.05);
    return rep;
  }

  const thickness = armorFor(spec, face);
  const cosI = Math.max(-1, Math.min(1, -hit.n.dot(inp.d)));
  let angle = (Math.acos(Math.max(0, cosI)) * 180) / Math.PI;
  rep.thickness = thickness;
  rep.angle = Math.round(angle);
  const overmatch = a.caliber > thickness * 3;
  if (!overmatch) angle = Math.max(0, angle - normalizationOf(a));
  else angle *= 0.5;
  const rico = ricochetAngleOf(a);
  const cosE = Math.max(0.08, Math.cos((angle * Math.PI) / 180));
  const effective = thickness / (a.kind === 'APCR' ? Math.pow(cosE, 1.2) : cosE);
  rep.effective = Math.round(effective);
  const pen = isBlastAmmo ? a.pen100 : penAt(a, inp.dist) * rand(0.94, 1.06);
  rep.pen = Math.round(pen);
  const isTrack = face === 'trackL' || face === 'trackR';

  // track hits always damage running gear
  const ctx = new DamageCtx(spec, st, lay, a, ctxTargets);
  if (isTrack) {
    const ti = lay.modules.findIndex((m) => m.type === face);
    ctx.addMod(ti, a.kind === 'MG' ? a.caliber * 0.2 : a.caliber * (isBlastAmmo ? 1.6 : 0.9) + a.explosive * 60);
  }

  if (!overmatch && !isBlastAmmo && angle > rico - 6 && Math.random() < Math.min(1, (angle - (rico - 6)) / 12)) {
    rep.result = 'ricochet';
    finishReport(spec, st, rep, isTrack ? ctx : null, 0);
    return rep;
  }

  const dirIn = inp.d.clone();
  const entry = P.clone().addScaledVector(dirIn, 0.05);
  const calF = Math.sqrt(a.caliber / 75);

  if (isBlastAmmo) {
    if (pen >= effective) {
      // HE penetrates thin armor: blast inside
      rep.result = 'pen';
      const nf = 10 + Math.round(a.explosive * 25);
      for (let i = 0; i < nf; i++) ctx.frag(entry, randomCone(dirIn, 70), 2.2, rand(25, 55) * (0.6 + a.explosive), 1);
      finishReport(spec, st, rep, ctx, a.damage * 1.6);
    } else {
      rep.result = isTrack ? 'module' : 'nonpen';
      // shock & spalling against thin plates
      const blastPen = Math.sqrt(a.explosive) * 22;
      if (effective < blastPen * 1.4) {
        rep.result = 'partial';
        for (let i = 0; i < 3 + Math.round(a.explosive * 4); i++) ctx.frag(entry, randomCone(dirIn, 55), 1.4, rand(10, 25), 1);
      }
      // external components near the impact
      lay.modules.forEach((m, i) => {
        if (m.type !== 'barrel' && !isTrack) return;
        const c = m.inTurret ? turretToHull(m.c, inp.turretYaw, lay.turretBase) : m.c;
        if (c.distanceTo(P) < 1.0 + a.explosive) ctx.addMod(i, 20 * a.explosive + 10);
      });
      finishReport(spec, st, rep, ctx, a.damage * 0.15);
    }
    return rep;
  }

  if (pen >= effective) {
    rep.result = 'pen';
    const shellEnd: THREE.Vector3 = entry.clone();
    if (a.kind === 'APHE') {
      const fuse = 1.0 + Math.random() * 0.8;
      // shell body travels until the fuse fires
      ctx.frag(entry, dirIn, fuse, a.caliber * 1.5, 2);
      shellEnd.addScaledVector(dirIn, fuse);
      const burst = shellEnd;
      const nf = 8 + Math.round(a.explosive * 140) + Math.round(a.caliber / 12);
      for (let i = 0; i < nf; i++) ctx.frag(burst, randomCone(dirIn, 95), 2.4, rand(28, 60) * calF, 1);
      for (let i = 0; i < Math.round(a.caliber / 15); i++) ctx.frag(entry, randomCone(dirIn, 22), 2.2, rand(15, 30) * calF, 1);
    } else {
      const len = a.kind === 'APCR' ? 3.2 : 4.5;
      ctx.frag(entry, dirIn, len, a.caliber * (a.kind === 'MG' ? 1.2 : 1.6), a.kind === 'MG' ? 1 : 3);
      shellEnd.addScaledVector(dirIn, len);
      const ns = a.kind === 'MG' ? 1 : a.kind === 'APCR' ? 3 + Math.round(a.caliber / 20) : 5 + Math.round(a.caliber / 9);
      const cone = a.kind === 'APCR' ? 14 : 26;
      for (let i = 0; i < ns; i++) ctx.frag(entry, randomCone(dirIn, cone), 2.6, rand(18, 38) * calF * (a.kind === 'MG' ? 0.4 : 1), 1);
    }
    rep.shellPath = [entry.x, entry.y, entry.z, shellEnd.x, shellEnd.y, shellEnd.z].map(r2);
    finishReport(spec, st, rep, ctx, a.damage * rand(0.85, 1.15));
  } else if (pen >= effective * 0.93) {
    rep.result = 'partial';
    const ns = 2 + Math.round(a.caliber / 18);
    for (let i = 0; i < ns; i++) ctx.frag(entry, randomCone(dirIn, 40), 1.5, rand(8, 22) * calF, 1);
    finishReport(spec, st, rep, ctx, a.damage * 0.25);
  } else {
    rep.result = isTrack ? 'module' : 'nonpen';
    finishReport(spec, st, rep, isTrack ? ctx : null, 0);
  }
  return rep;
}

/** Explosion (bomb, rocket near-miss, HE splash) at a hull-local point. */
export function resolveBlast(spec: TankSpec, st: DamageState, centre: THREE.Vector3, ammo: AmmoSpec, time: number,
  shooter: string, shooterName: string, target: string, targetName: string, turretYaw: number): HitReport | null {
  if (st.destroyed) return null;
  const lay = getLayout(spec);
  const M = ammo.explosive;
  const R = ammo.kind === 'BOMB' ? 3.2 * Math.cbrt(M) : 1.5 + M * 2;
  // distance from blast to the closest point of the hull bounding box
  const h = spec.hull;
  const cx = Math.max(-h.W / 2, Math.min(h.W / 2, centre.x));
  const cy = Math.max(0, Math.min(h.H + spec.turret.h, centre.y));
  const cz = Math.max(-h.L / 2, Math.min(h.L / 2, centre.z));
  const closest = new THREE.Vector3(cx, cy, cz);
  const d = closest.distanceTo(centre);
  if (d > R) return null;
  const s = 1 - d / R;
  const fake: ShotInput = { o: centre, d: closest.clone().sub(centre).normalize(), ammo, dist: 0, turretYaw, gunPitch: 0, time, shooter, shooterName, target, targetName };
  const rep = baseReport(spec, fake, 'blast');
  rep.result = 'blast';
  rep.point = [r2(closest.x), r2(closest.y), r2(closest.z)];
  // which armor faces the blast?
  let face = 'roof';
  const rel = centre.clone().sub(new THREE.Vector3(0, h.H / 2, 0));
  if (centre.y < h.H * 0.8) {
    if (Math.abs(rel.z) / (h.L / 2) > Math.abs(rel.x) / (h.W / 2)) face = rel.z > 0 ? 'upperFront' : 'upperRear';
    else face = rel.x > 0 ? 'left' : 'right';
  }
  const thick = armorFor(spec, face);
  rep.section = SECTION_NAMES[face];
  rep.thickness = thick;
  rep.effective = thick;
  const penB = ammo.kind === 'BOMB' ? s * s * Math.sqrt(M) * 13 : Math.sqrt(M) * 22 * s;
  rep.pen = Math.round(penB);
  const ctx = new DamageCtx(spec, st, lay, ammo, internalTargets(spec, st, lay, turretYaw));
  if (penB > thick) {
    const entry = closest.clone().lerp(new THREE.Vector3(0, h.H * 0.55, 0), 0.15);
    const dir = new THREE.Vector3(0, h.H * 0.5, 0).sub(entry).normalize();
    const nf = 8 + Math.round(Math.min(40, M / 4));
    for (let i = 0; i < nf; i++) ctx.frag(entry, randomCone(dir, 60), 3, rand(30, 80) * s, 1);
    rep.result = 'pen';
  } else if (penB > thick * 0.6) {
    const entry = closest.clone();
    const dir = new THREE.Vector3(0, h.H * 0.5, 0).sub(entry).normalize();
    for (let i = 0; i < 4; i++) ctx.frag(entry, randomCone(dir, 50), 1.6, rand(10, 25) * s, 1);
    rep.result = 'partial';
  }
  // external damage: tracks & gun
  lay.modules.forEach((m, i) => {
    if (m.type === 'trackL' || m.type === 'trackR' || m.type === 'barrel') {
      const c = m.inTurret ? turretToHull(m.c, turretYaw, lay.turretBase) : m.c;
      const dd = c.distanceTo(centre);
      if (dd < R * 0.8) ctx.addMod(i, (1 - dd / (R * 0.8)) * (ammo.kind === 'BOMB' ? 150 : 60));
    }
  });
  finishReport(spec, st, rep, ctx, ammo.damage * s * s * (penB > thick ? 1 : 0.25));
  return rep;
}

/** Per-frame damage over time (fire, cook-off). Returns true if destroyed this tick. */
export function tickDamage(spec: TankSpec, st: DamageState, dt: number): { destroyed: boolean; detonated: boolean; fireOut: boolean } {
  const res = { destroyed: false, detonated: false, fireOut: false };
  if (st.fire > 0 && !st.destroyed) {
    st.fire += dt;
    st.structure -= 1.6 * dt;
    st.crew = st.crew.map((h) => (h > 0 ? Math.max(0, h - 1.1 * dt) : 0));
    const lay = getLayout(spec);
    const eng = lay.modules.find((m) => m.type === 'engine')!;
    st.modules[eng.idx] = Math.max(0, st.modules[eng.idx] - 2.5 * dt);
    if (Math.random() < 0.012 * dt && st.rounds.some((r) => r > 0)) { st.detonated = true; st.crew = st.crew.map(() => 0); st.structure = 0; res.detonated = true; }
    if (st.fire > 22 && Math.random() < 0.08 * dt) { st.fire = 0; res.fireOut = true; }
    checkDestroyed(spec, st);
    if (st.destroyed) res.destroyed = true;
  }
  return res;
}

export function healCrew(st: DamageState, amount: number, revive = false) {
  st.crew = st.crew.map((h) => (h > 0 ? Math.min(100, h + amount) : revive ? Math.min(100, amount) : 0));
}

export function repairModules(spec: TankSpec, st: DamageState, fraction: number, full = false) {
  const lay = getLayout(spec);
  lay.modules.forEach((m, i) => {
    const target = full ? m.maxHp : Math.max(st.modules[i], m.maxHp * fraction);
    st.modules[i] = Math.min(m.maxHp, Math.max(st.modules[i], target));
  });
}

export function ammoById(id: string) { return AMMO[id]; }

/** Non-mutating penetration estimate used for the reticle colour. */
export function previewShot(spec: TankSpec, o: THREE.Vector3, d: THREE.Vector3, ammo: AmmoSpec, dist: number, turretYaw: number, gunPitch: number): { verdict: 'pen' | 'maybe' | 'no' | 'none'; effective: number; pen: number; section: string } {
  const hit = intersectTank(spec, o, d, turretYaw, gunPitch, 400);
  if (!hit) return { verdict: 'none', effective: 0, pen: 0, section: '' };
  if (hit.part === 'barrel') return { verdict: 'maybe', effective: 0, pen: 0, section: SECTION_NAMES.barrel };
  const P = o.clone().addScaledVector(d, hit.t);
  let face = hit.face;
  if (hit.part === 'hull' && (face === 'left' || face === 'right') && P.y < spec.hull.trackTop) face = face === 'left' ? 'trackL' : 'trackR';
  if (hit.part === 'turret' && face === 'turretFront' && Math.abs(hit.localP.x) < spec.turret.mantletW / 2 && Math.abs(hit.localP.y - spec.turret.gunY) < 0.38) face = 'mantlet';
  const th = armorFor(spec, face);
  let ang = (Math.acos(Math.max(0, Math.min(1, -hit.n.dot(d)))) * 180) / Math.PI;
  const over = ammo.caliber > th * 3;
  ang = over ? ang * 0.5 : Math.max(0, ang - normalizationOf(ammo));
  const eff = th / Math.max(0.08, Math.cos((ang * Math.PI) / 180));
  const pen = ammo.kind === 'HE' || ammo.kind === 'ROCKET' ? ammo.pen100 : penAt(ammo, dist);
  const rico = !over && ang > ricochetAngleOf(ammo) - 4;
  const verdict = rico ? 'no' : pen > eff * 1.08 ? 'pen' : pen > eff * 0.9 ? 'maybe' : 'no';
  return { verdict, effective: Math.round(eff), pen: Math.round(pen), section: SECTION_NAMES[face] ?? face };
}
