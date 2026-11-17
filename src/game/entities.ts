import * as THREE from 'three';
import { AMMO, type AmmoSpec } from './data/ammo';
import type { AircraftSpec, TankSpec } from './data/vehicles';
import { audio, type EngineSound } from './audio';
import { buildAircraftModel, buildTankModel, type AircraftModel, type TankModel } from './render/models';
import { aliveCrew, healCrew, newDamageState, repairModules, tankModifiers, tickDamage, totalRounds, type DamageState, type TankModifiers } from './sim/damage';
import { getLayout } from './sim/layout';
import type { World } from './world/world';
import type { Effects } from './render/effects';

export type Team = 0 | 1;

export interface GameCtx {
  world: World; effects: Effects; scene: THREE.Scene; time: number; myId: string;
  vehicles: Map<string, Vehicle>;
  fireProjectile(shooter: Vehicle, ammo: AmmoSpec, pos: THREE.Vector3, vel: THREE.Vector3, visualOnly?: boolean): void;
  send(msg: unknown, to?: string): void;
  onBuildingRam(idx: number, dmg: number): void;
  onTreeKnock(idx: number, dir: number): void;
  onLocalDestroyed(v: Vehicle, cause: string): void;
  rules: { medkits: boolean; crewReplacement: boolean };
  spawnZone(team: Team): THREE.Vector3;
  shadows: boolean;
  camPos: THREE.Vector3;
}

export interface Snapshot { t: number; p: THREE.Vector3; q: THREE.Quaternion; a: number; b: number; s: number; f: number; }

export abstract class Vehicle {
  abstract kind: 'tank' | 'aircraft';
  pos = new THREE.Vector3();
  quat = new THREE.Quaternion();
  vel = new THREE.Vector3();
  alive = true;
  deadAt = 0;
  spawnedAt = 0;
  lastShot = -100;
  buf: Snapshot[] = [];
  local = false;
  root!: THREE.Object3D;
  lastAttacker = '';
  lastAttackerTime = 0;
  constructor(public id: string, public name: string, public team: Team, public isBot: boolean, public owner: string) {}
  abstract get spec(): TankSpec | AircraftSpec;
  abstract update(dt: number, ctx: GameCtx): void;
  abstract snapshot(): (number | string)[];
  abstract applySnapshot(s: (number | string)[], t: number): void;
  abstract dispose(ctx: GameCtx): void;
  /** Interpolate remote state. */
  protected interp(renderT: number): { a: Snapshot; b: Snapshot; k: number } | null {
    const b = this.buf;
    if (!b.length) return null;
    while (b.length > 2 && b[1].t <= renderT) b.shift();
    if (b.length === 1 || renderT <= b[0].t) return { a: b[0], b: b[0], k: 0 };
    const k = Math.min(1.5, (renderT - b[0].t) / Math.max(0.001, b[1].t - b[0].t));
    return { a: b[0], b: b[1], k };
  }
  forward(out = new THREE.Vector3()) { return out.set(0, 0, 1).applyQuaternion(this.quat); }
  get center(): THREE.Vector3 { return this.pos; }
}

// ============================================================ TANK

export interface TankInput { throttle: number; steer: number; brake: boolean; aim: THREE.Vector3 | null; fire: boolean; }

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

export function ballisticPitch(v: number, dx: number, dy: number): number {
  const g = 9.81;
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * dx * dx + 2 * dy * v2);
  if (disc < 0 || dx < 1) return Math.atan2(dy, Math.max(1, dx));
  return Math.atan((v2 - Math.sqrt(disc)) / (g * dx));
}

export class Tank extends Vehicle {
  kind = 'tank' as const;
  model: TankModel;
  dmg: DamageState;
  mods: TankModifiers;
  yaw = 0; pitch = 0; roll = 0; speed = 0; yawRate = 0;
  turretYaw = 0; gunPitch = 0;
  reload = 0; loaded = 0; selected = 0; clip = 0;
  bloom = 0.02;
  thr = 0; str = 0;
  input: TankInput = { throttle: 0, steer: 0, brake: false, aim: null, fire: false };
  recoil = 0;
  baseTimer = 0;
  repairTotal = 0;
  extTotal = 2.5;
  private engine: EngineSound | null = null;
  private wheelRot = 0;
  private dustAcc = 0;
  private emittersAttached = false;
  private colOut = { px: 0, pz: 0, hits: [] as number[], trees: [] as number[] };
  turretDetached = false;
  private turretVel = new THREE.Vector3();
  private turretSpin = new THREE.Vector3();
  waterWarned = false;
  remoteFire = false;

  constructor(id: string, name: string, team: Team, isBot: boolean, owner: string, public tspec: TankSpec, ctx: GameCtx) {
    super(id, name, team, isBot, owner);
    this.model = buildTankModel(tspec, ctx.shadows);
    this.root = this.model.root;
    ctx.scene.add(this.root);
    this.dmg = newDamageState(tspec);
    this.mods = tankModifiers(tspec, this.dmg);
    this.clip = tspec.gun.clip?.size ?? 1;
  }
  get spec() { return this.tspec; }

  spawn(x: number, z: number, yaw: number, ctx: GameCtx) {
    this.pos.set(x, ctx.world.height(x, z), z);
    this.yaw = yaw; this.pitch = 0; this.roll = 0; this.speed = 0; this.turretYaw = 0; this.gunPitch = 0;
    this.dmg = newDamageState(this.tspec);
    this.mods = tankModifiers(this.tspec, this.dmg);
    this.alive = true; this.reload = 1.5; this.clip = this.tspec.gun.clip?.size ?? 1; this.loaded = this.selected;
    this.spawnedAt = ctx.time; this.buf = [];
    this.turretDetached = false;
    this.model.turret.position.copy(getLayout(this.tspec).turretBase);
    this.model.turret.rotation.set(0, 0, 0);
    if (this.model.turret.parent !== this.model.hull) this.model.hull.add(this.model.turret);
    this.model.mats.burnt.value = 0;
    this.emittersAttached = false;
    this.root.visible = true;
    this.updateTransform();
    this.attachEmitters(ctx);
  }

  private attachEmitters(ctx: GameCtx) {
    if (this.emittersAttached) return;
    this.emittersAttached = true;
    const spawnT = this.spawnedAt;
    const firePos = () => {
      const lay = getLayout(this.tspec);
      const eng = lay.modules.find((m) => m.type === 'engine')!;
      return this.model.hull.localToWorld(_v2.copy(eng.c).setY(this.tspec.hull.H + 0.2)).clone();
    };
    ctx.effects.attach(firePos, 'fire', () => this.spawnedAt === spawnT && this.dmg.fire > 0 && (this.alive || ctx.time - this.deadAt < 25));
    ctx.effects.attach(() => this.pos.clone().setY(this.pos.y + this.tspec.hull.H), 'wreck', () => this.spawnedAt === spawnT && !this.alive && ctx.time - this.deadAt < 40);
  }

  get selectedAmmo(): AmmoSpec { return AMMO[this.tspec.gun.ammo[this.selected]]; }
  get loadedAmmo(): AmmoSpec { return AMMO[this.tspec.gun.ammo[this.loaded]]; }

  selectAmmo(i: number) {
    if (i < 0 || i >= this.tspec.gun.ammo.length || i === this.selected) return;
    this.selected = i;
    // switching ammunition means unloading the round in the breech
    if (!this.tspec.gun.clip && this.reload <= 0) this.reload = this.tspec.gun.reload;
    if (this.tspec.gun.clip) { this.clip = 0; this.reload = this.tspec.gun.reload; }
    this.loaded = i;
  }

  updateTransform() {
    _e.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    this.quat.setFromEuler(_e);
    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);
    if (!this.turretDetached) {
      this.model.turret.rotation.y = this.turretYaw;
      this.model.gun.rotation.x = -this.gunPitch;
    }
    this.model.barrel.position.z = 0.4 + this.tspec.gun.length / 2 - this.recoil * 0.35;
  }

  /** World-space muzzle position and gun direction. */
  muzzle(outP: THREE.Vector3, outD: THREE.Vector3) {
    this.root.updateMatrixWorld(true);
    this.model.muzzle.getWorldPosition(outP);
    outD.set(0, 0, 1).applyQuaternion(this.model.gun.getWorldQuaternion(_q));
  }

  /** Hull-local transform helpers. */
  worldToLocal(p: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(p).sub(this.pos).applyQuaternion(_q.copy(this.quat).invert());
  }
  dirToLocal(d: THREE.Vector3, out = new THREE.Vector3()) { return out.copy(d).applyQuaternion(_q.copy(this.quat).invert()); }
  localToWorld(p: THREE.Vector3, out = new THREE.Vector3()) { return out.copy(p).applyQuaternion(this.quat).add(this.pos); }

  get center(): THREE.Vector3 { return _v1.copy(this.pos).addScaledVector(UP, this.tspec.hull.H * 0.7); }

  update(dt: number, ctx: GameCtx) {
    if (this.local) this.simulate(dt, ctx);
    else this.remoteUpdate(ctx);
    this.animate(dt, ctx);
  }

  private simulate(dt: number, ctx: GameCtx) {
    const s = this.tspec;
    const w = ctx.world;
    if (!this.alive) {
      this.speed *= Math.exp(-3 * dt);
      this.pos.addScaledVector(this.forward(_v1).setY(0).normalize(), this.speed * dt);
      this.pos.y = w.height(this.pos.x, this.pos.z);
      this.updateTransform();
      if (this.turretDetached) this.flyTurret(dt, ctx);
      return;
    }
    // ---------------- damage over time
    const tick = tickDamage(s, this.dmg, dt);
    if (tick.destroyed) ctx.onLocalDestroyed(this, tick.detonated ? 'ammo detonation' : 'fire');
    if (!this.alive) return;
    const m = (this.mods = tankModifiers(s, this.dmg));

    // ---------------- service actions
    if (this.dmg.repairing > 0) {
      if (Math.abs(this.speed) > 1) this.dmg.repairing = 0;
      else {
        this.dmg.repairing -= dt;
        if (this.dmg.repairing <= 0) { this.dmg.repairing = 0; repairModules(s, this.dmg, 0.4); this.fixTracks(); }
      }
    }
    if (this.dmg.extinguishing > 0) {
      this.dmg.extinguishing -= dt;
      if (this.dmg.extinguishing <= 0) { this.dmg.extinguishing = 0; this.dmg.fire = 0; }
    }
    // crew replacement / resupply in the home base zone
    const base = ctx.spawnZone(this.team);
    const inBase = Math.hypot(this.pos.x - base.x, this.pos.z - base.z) < 70;
    if (inBase && Math.abs(this.speed) < 1 && ctx.rules.crewReplacement && this.needsService()) {
      this.baseTimer += dt;
      if (this.baseTimer > 6) {
        this.baseTimer = 0;
        healCrew(this.dmg, 70, true);
        repairModules(s, this.dmg, 1, true);
        this.dmg.extinguishers = 2; this.dmg.medkits = ctx.rules.medkits ? 1 : 0;
        this.dmg.structure = Math.min(this.dmg.maxStructure, this.dmg.structure + this.dmg.maxStructure * 0.5);
      }
    } else this.baseTimer = 0;

    // ---------------- driving
    const inp = this.input;
    const canMove = m.canMove && this.dmg.repairing <= 0;
    const resp = 2.5 * m.steering; // injured drivers react slower
    this.thr += ((canMove ? inp.throttle : 0) - this.thr) * Math.min(1, dt * resp * 1.5);
    this.str += ((canMove ? inp.steer : 0) - this.str) * Math.min(1, dt * resp * 2);
    const vmax = (s.maxSpeed / 3.6) * m.maxSpeed * m.mobility;
    const vrev = (s.reverse / 3.6) * m.maxSpeed * m.mobility;
    const ground = this.groundFactor(w);
    const pw = (s.power / s.mass) * m.power * m.mobility;
    const accel = Math.min(4.5, 0.12 * pw + 0.6) * ground;
    let target = this.thr >= 0 ? this.thr * vmax * ground : this.thr * vrev;
    if (inp.brake || !canMove) target = 0;
    const dv = target - this.speed;
    const braking = Math.sign(target) !== Math.sign(this.speed) || Math.abs(target) < Math.abs(this.speed);
    const rate = braking ? 5.5 : accel;
    this.speed += Math.sign(dv) * Math.min(Math.abs(dv), rate * dt);
    // gravity on slopes
    this.speed -= 9.81 * Math.sin(this.pitch) * dt * 0.55 * (canMove ? 0.6 : 1);
    if (!canMove && Math.abs(this.speed) < 0.3) this.speed = 0;
    const turnRate = ((s.hullTraverse * Math.PI) / 180) * m.steering * (1 - 0.35 * Math.min(1, Math.abs(this.speed) / Math.max(1, vmax)));
    this.yawRate = canMove ? -this.str * turnRate * (this.speed < -0.3 ? -1 : 1) : 0;
    this.yaw += this.yawRate * dt;
    const fwd = _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.pos.addScaledVector(fwd, this.speed * dt);

    // ---------------- collisions
    const hw = s.hull.W / 2;
    let bump = false;
    for (const off of [s.hull.L * 0.3, 0, -s.hull.L * 0.3]) {
      const cx = this.pos.x + fwd.x * off, cz = this.pos.z + fwd.z * off;
      w.collideCircle(cx, cz, hw, this.pos.y + 0.5, this.colOut);
      if (this.colOut.hits.length) {
        for (const bi of this.colOut.hits) {
          const ram = s.mass * Math.abs(this.speed) * 0.5;
          if (ram > 8) ctx.onBuildingRam(bi, ram);
        }
        this.pos.x += this.colOut.px; this.pos.z += this.colOut.pz;
        bump = true;
      }
      for (const ti of this.colOut.trees) {
        if (Math.abs(this.speed) > 1.2 || s.mass > 30) { ctx.onTreeKnock(ti, this.yaw + (this.speed < 0 ? Math.PI : 0)); this.speed *= 0.85; }
        else { this.speed *= 0.5; }
      }
    }
    if (bump) this.speed *= 0.6;
    for (const o of ctx.vehicles.values()) {
      if (o === this || o.kind !== 'tank' || !o.root.visible) continue;
      const ot = o as Tank;
      const dx = this.pos.x - ot.pos.x, dz = this.pos.z - ot.pos.z;
      const rr = (s.hull.L + ot.tspec.hull.L) * 0.38;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const pushK = ot.tspec.mass / (ot.tspec.mass + s.mass);
        this.pos.x += (dx / d) * (rr - d) * pushK; this.pos.z += (dz / d) * (rr - d) * pushK;
        this.speed *= 0.7;
      }
    }
    if (w.clampToBounds(this.pos)) this.speed *= 0.5;

    // ---------------- terrain following
    const L = s.hull.L * 0.42, W = s.hull.W * 0.42;
    const hf = w.height(this.pos.x + fwd.x * L, this.pos.z + fwd.z * L);
    const hb = w.height(this.pos.x - fwd.x * L, this.pos.z - fwd.z * L);
    const hl = w.height(this.pos.x + fwd.z * W, this.pos.z - fwd.x * W);
    const hr = w.height(this.pos.x - fwd.z * W, this.pos.z + fwd.x * W);
    const tp = Math.atan2(hf - hb, 2 * L), tr = Math.atan2(hl - hr, 2 * W);
    const k = Math.min(1, dt * 8);
    this.pitch += (tp - this.pitch) * k;
    this.roll += (-tr - this.roll) * k;
    this.pos.y = (hf + hb + hl + hr) / 4;
    // water
    if (w.map.water !== null) {
      const depth = w.map.water - this.pos.y;
      if (depth > 0.4) this.speed *= Math.exp(-dt * 1.5);
      if (depth > s.hull.H * 0.75) {
        const eng = getLayout(s).modules.find((x) => x.type === 'engine')!;
        if (this.dmg.modules[eng.idx] > 0) { this.dmg.modules[eng.idx] = 0; this.waterWarned = true; }
      }
    }

    // ---------------- turret & gun
    const g = s.gun;
    const turretRate = ((s.turretTraverse * Math.PI) / 180) * m.traverse;
    const elevRate = (Math.max(4, s.turretTraverse * 0.35) * Math.PI / 180) * (0.4 + 0.6 * m.traverse);
    let traversing = 0;
    if (inp.aim && this.dmg.repairing <= 0) {
      this.updateTransform();
      this.root.updateMatrixWorld(true);
      const lay = getLayout(s);
      const local = this.worldToLocal(inp.aim, _v2);
      const lx = local.x - lay.turretBase.x, lz = local.z - lay.turretBase.z;
      const desiredYaw = Math.atan2(lx, lz);
      let dy = desiredYaw - this.turretYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const step = Math.sign(dy) * Math.min(Math.abs(dy), turretRate * dt);
      this.turretYaw += step;
      traversing = Math.abs(step) / Math.max(1e-4, dt);
      const horiz = Math.hypot(lx, lz);
      const ammo = this.loadedAmmo;
      const desiredPitch = ballisticPitch(ammo.velocity || 300, horiz, local.y - (lay.turretBase.y + lay.trunnion.y)) ;
      const lim = [(s.elev[0] * Math.PI) / 180, (s.elev[1] * Math.PI) / 180];
      const tgt = Math.max(lim[0], Math.min(lim[1], desiredPitch));
      const dp = tgt - this.gunPitch;
      this.gunPitch += Math.sign(dp) * Math.min(Math.abs(dp), elevRate * dt);
    }
    // ---------------- dispersion
    const baseDisp = (g.dispersion / 1000) * m.dispersion;
    const moveBloom = Math.abs(this.speed) * 0.0028 + Math.abs(this.yawRate) * 0.03 + traversing * 0.025;
    const aimT = g.aimTime * m.aimTime;
    this.bloom = Math.max(baseDisp, this.bloom + (moveBloom - (this.bloom - baseDisp) * (2.3 / aimT)) * dt);
    this.bloom = Math.min(this.bloom, 0.06);

    // ---------------- reload & fire
    const loaderRate = 1 / m.reload;
    if (this.reload > 0) {
      this.reload -= dt * loaderRate * (this.dmg.repairing > 0 ? 0 : 1);
      if (this.reload <= 0) {
        this.reload = 0;
        if (g.clip && this.clip <= 0) this.clip = g.clip.size;
        if (!this.isBot && this.owner === ctx.myId) audio.reloadDone(g.caliber);
      }
    }
    if (inp.fire && this.reload <= 0 && m.canFire && this.dmg.repairing <= 0) this.fire(ctx);
    this.updateTransform();
  }

  private flyTurret(dt: number, ctx: GameCtx) {
    const t = this.model.turret;
    this.turretVel.y -= 9.81 * dt;
    t.position.addScaledVector(this.turretVel, dt);
    t.rotation.x += this.turretSpin.x * dt; t.rotation.z += this.turretSpin.z * dt;
    const gy = ctx.world.height(t.position.x, t.position.z);
    if (t.position.y < gy + 0.3) { t.position.y = gy + 0.3; this.turretVel.set(0, 0, 0); this.turretSpin.multiplyScalar(0); }
  }

  /** Blow the turret off (ammo detonation). */
  detachTurret(ctx: GameCtx) {
    if (this.turretDetached) return;
    this.turretDetached = true;
    const t = this.model.turret;
    this.root.updateMatrixWorld(true);
    const wp = t.getWorldPosition(new THREE.Vector3());
    const wq = t.getWorldQuaternion(new THREE.Quaternion());
    ctx.scene.add(t);
    t.position.copy(wp); t.quaternion.copy(wq);
    this.turretVel.set((Math.random() - 0.5) * 6, 9 + Math.random() * 6, (Math.random() - 0.5) * 6);
    this.turretSpin.set((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4);
  }

  needsService(): boolean {
    return this.dmg.crew.some((h) => h < 100) || this.dmg.modules.some((h, i) => h < getLayout(this.tspec).modules[i].maxHp) || this.dmg.structure < this.dmg.maxStructure * 0.9;
  }

  private fixTracks() {
    const lay = getLayout(this.tspec);
    for (const mm of lay.modules) if (mm.type === 'trackL' || mm.type === 'trackR') this.dmg.modules[mm.idx] = Math.max(this.dmg.modules[mm.idx], mm.maxHp);
  }

  private groundFactor(w: World): number {
    // roads are faster, sand slower
    const theme = w.map.def.id;
    return theme === 'africa' ? 0.85 : theme === 'stalingrad' ? 0.95 : 0.92;
  }

  fire(ctx: GameCtx) {
    const g = this.tspec.gun;
    const ammo = this.loadedAmmo;
    const p = new THREE.Vector3(), d = new THREE.Vector3();
    this.muzzle(p, d);
    // dispersion cone
    const r = this.bloom * Math.sqrt(Math.random()) * 0.5, a = Math.random() * Math.PI * 2;
    const right = _v1.crossVectors(d, UP).normalize();
    const up = _v2.crossVectors(right, d).normalize();
    d.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    const vel = d.clone().multiplyScalar(ammo.velocity).addScaledVector(this.forward(new THREE.Vector3()), this.speed);
    ctx.fireProjectile(this, ammo, p, vel);
    // consume a round from the racks (ready rack first)
    const lay = getLayout(this.tspec);
    const racks = lay.modules.filter((m) => m.type === 'ammo' && this.dmg.rounds[m.idx] > 0);
    if (racks.length) this.dmg.rounds[racks[racks.length - 1].idx] -= 1;
    if (g.clip) {
      this.clip--;
      this.reload = this.clip > 0 ? g.clip.interval : g.reload;
    } else this.reload = g.reload;
    this.loaded = this.selected;
    this.recoil = 1;
    this.bloom = Math.min(0.06, this.bloom + (g.dispersion / 1000) * 2);
    this.lastShot = ctx.time;
  }

  /** Service actions (player or AI). */
  startRepair(): boolean {
    if (this.dmg.repairing > 0 || !this.alive) return false;
    const lay = getLayout(this.tspec);
    const broken = lay.modules.some((m, i) => this.dmg.modules[i] <= 0 || ((m.type === 'trackL' || m.type === 'trackR') && this.dmg.modules[i] < m.maxHp));
    if (!broken) return false;
    const crewF = this.dmg.crew.reduce((a, h) => a + (h > 0 ? 0.4 + 0.6 * h / 100 : 0), 0) / this.dmg.crew.length;
    this.dmg.repairing = this.repairTotal = 10 / Math.max(0.2, crewF);
    return true;
  }
  extinguish(): boolean {
    if (this.dmg.fire <= 0 || this.dmg.extinguishers <= 0 || this.dmg.extinguishing > 0) return false;
    this.dmg.extinguishers--;
    this.dmg.extinguishing = this.extTotal = 2.5;
    return true;
  }
  useMedkit(ctx: { rules: { medkits: boolean } }): boolean {
    if (!ctx.rules.medkits || this.dmg.medkits <= 0) return false;
    if (!this.dmg.crew.some((h) => h > 0 && h < 100)) return false;
    this.dmg.medkits--;
    healCrew(this.dmg, 50, false);
    return true;
  }

  private remoteUpdate(ctx: GameCtx) {
    const r = this.interp(ctx.time - 0.12);
    if (!r) return;
    const { a, b, k } = r;
    this.pos.lerpVectors(a.p, b.p, k);
    // stored yaw/pitch/roll as quaternion
    this.quat.slerpQuaternions(a.q, b.q, Math.min(1, k));
    _e.setFromQuaternion(this.quat, 'YXZ');
    this.yaw = _e.y; this.pitch = -_e.x; this.roll = _e.z;
    let dy = b.a - a.a; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.turretYaw = a.a + dy * Math.min(1, k);
    this.gunPitch = a.b + (b.b - a.b) * Math.min(1, k);
    this.speed = b.s;
    const aliveNow = (b.f & 1) === 1;
    if (!aliveNow && this.alive) { this.alive = false; this.deadAt = ctx.time; this.model.mats.burnt.value = 1; }
    if (aliveNow && !this.alive) { this.alive = true; this.model.mats.burnt.value = 0; }
    this.remoteFire = (b.f & 2) === 2;
    if ((b.f & 4) === 4 && !this.turretDetached) this.detachTurret(ctx);
    this.dmg.fire = this.remoteFire ? Math.max(this.dmg.fire, 0.01) : 0;
    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);
    if (!this.turretDetached) { this.model.turret.rotation.y = this.turretYaw; this.model.gun.rotation.x = -this.gunPitch; }
  }

  private animate(dt: number, ctx: GameCtx) {
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.model.barrel.position.z = 0.4 + this.tspec.gun.length / 2 - this.recoil * 0.35;
    this.wheelRot += (this.speed * dt) / this.tspec.hull.wheelR;
    const lTrack = this.mods.trackL, rTrack = this.mods.trackR;
    const turnSpin = this.yawRate * this.tspec.hull.W * 0.5 * dt / this.tspec.hull.wheelR;
    for (const wl of this.model.wheelsL) wl.rotation.x = lTrack ? this.wheelRot - turnSpin : wl.rotation.x;
    for (const wr of this.model.wheelsR) wr.rotation.x = rTrack ? this.wheelRot + turnSpin : wr.rotation.x;
    this.model.trackL.visible = lTrack || !this.local;
    this.model.trackR.visible = rTrack || !this.local;
    if (!this.alive) return;
    // exhaust & dust
    this.dustAcc += dt;
    if (this.dustAcc > 0.09) {
      this.dustAcc = 0;
      const ex = this.model.exhaust.getWorldPosition(_v2);
      ctx.effects.exhaust(ex, Math.abs(this.thr), this.forward(_v1).negate());
      if (Math.abs(this.speed) > 2 && ctx.world.map.def.id !== 'normandy') {
        const back = this.pos.clone().addScaledVector(this.forward(_v1), -this.tspec.hull.L * 0.45);
        ctx.effects.trackDust(back, Math.abs(this.speed), ctx.world.map.def.theme.dust);
      }
    }
    // engine sound
    const isMe = this.owner === ctx.myId && !this.isBot;
    const near = isMe || this.pos.distanceTo(ctx.camPos) < 250;
    if (near && !this.engine && audio.ctx) this.engine = audio.engine('tank', this.tspec.power > 450 ? 38 : 48, !isMe);
    if (this.engine) {
      const rpm = Math.min(1, Math.abs(this.speed) / Math.max(1, this.tspec.maxSpeed / 3.6) + Math.abs(this.thr) * 0.3);
      this.engine.set(this.mods.power > 0 ? rpm : 0, this.mods.power > 0 ? 0.3 + Math.abs(this.thr) * 0.7 : 0, this.pos);
      if (!near) { this.engine.stop(); this.engine = null; }
    }
  }

  onDestroyed(ctx: GameCtx, detonation: boolean) {
    this.alive = false;
    this.deadAt = ctx.time;
    this.model.mats.burnt.value = 1;
    this.dmg.fire = Math.max(this.dmg.fire, 0.01);
    if (this.engine) { this.engine.stop(); this.engine = null; }
    if (detonation) this.detachTurret(ctx);
  }

  snapshot(): (number | string)[] {
    const f = (this.alive ? 1 : 0) | (this.dmg.fire > 0 ? 2 : 0) | (this.turretDetached ? 4 : 0);
    const r = (x: number) => Math.round(x * 100) / 100;
    return [this.id, 0, r(this.pos.x), r(this.pos.y), r(this.pos.z), r(this.yaw), r(this.pitch), r(this.roll), r(this.turretYaw), r(this.gunPitch), r(this.speed), f];
  }

  applySnapshot(s: (number | string)[], t: number) {
    const n = s as number[];
    _e.set(-n[6], n[5], n[7], 'YXZ');
    this.buf.push({ t, p: new THREE.Vector3(n[2], n[3], n[4]), q: new THREE.Quaternion().setFromEuler(_e), a: n[8], b: n[9], s: n[10], f: n[11] });
    if (this.buf.length > 10) this.buf.shift();
  }

  dispose(ctx: GameCtx) {
    ctx.scene.remove(this.root);
    if (this.turretDetached) ctx.scene.remove(this.model.turret);
    if (this.engine) this.engine.stop();
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  }

  get crewAlive() { return aliveCrew(this.dmg); }
  get rounds() { return totalRounds(this.dmg); }
}

// ============================================================ AIRCRAFT

export interface PlaneInput { pitch: number; roll: number; yaw: number; throttle: number; guns: boolean; bomb: boolean; rocket: boolean; aim: THREE.Vector3 | null; }

export class Aircraft extends Vehicle {
  kind = 'aircraft' as const;
  model: AircraftModel;
  speed = 100;
  throttle = 0.8;
  hp = 100; engineHp = 100; pilot = 100; gunnerHp = 100; fire = 0;
  ammo: number[] = [];
  gunCd: number[] = [];
  bombs: { ammo: string; count: number }[] = [];
  rockets = 0;
  bombCd = 0; rocketCd = 0; gunnerCd = 0;
  input: PlaneInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, guns: false, bomb: false, rocket: false, aim: null };
  aimDir = new THREE.Vector3(0, 0, 1);
  firingGuns = false; gunnerFiring = false;
  private engine: EngineSound | null = null;
  private trailAcc = 0;
  private sirenState: { node?: { o: OscillatorNode; g: GainNode } } = {};
  private emittersAttached = false;
  crashed = false;
  gLoad = 1;
  private remoteGunAcc = 0;

  constructor(id: string, name: string, team: Team, isBot: boolean, owner: string, public aspec: AircraftSpec, ctx: GameCtx) {
    super(id, name, team, isBot, owner);
    this.model = buildAircraftModel(aspec, ctx.shadows);
    this.root = this.model.root;
    ctx.scene.add(this.root);
  }
  get spec() { return this.aspec; }
  get maxV() { return this.aspec.maxSpeed / 3.6; }
  get stallV() { return this.aspec.minSpeed / 3.6; }

  spawn(x: number, y: number, z: number, yaw: number, ctx: GameCtx) {
    this.pos.set(x, y, z);
    this.quat.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    this.aimDir.set(Math.sin(yaw), -0.02, Math.cos(yaw)).normalize();
    this.speed = this.maxV * 0.75; this.throttle = 0.85;
    this.hp = this.aspec.hp; this.engineHp = 100; this.pilot = 100; this.gunnerHp = 100; this.fire = 0;
    this.ammo = this.aspec.guns.map((g) => g.rounds);
    this.gunCd = this.aspec.guns.map(() => 0);
    this.bombs = this.aspec.bombs.map((b) => ({ ...b }));
    this.rockets = this.aspec.rockets?.count ?? 0;
    this.alive = true; this.crashed = false; this.spawnedAt = ctx.time; this.buf = [];
    this.model.mats.burnt.value = 0;
    this.root.visible = true;
    this.root.position.copy(this.pos); this.root.quaternion.copy(this.quat);
    this.emittersAttached = false;
    this.attachEmitters(ctx);
  }

  private attachEmitters(ctx: GameCtx) {
    if (this.emittersAttached) return;
    this.emittersAttached = true;
    const st = this.spawnedAt;
    ctx.effects.attach(() => this.pos.clone(), 'fire', () => this.spawnedAt === st && this.fire > 0 && !this.crashed);
    ctx.effects.attach(() => this.pos.clone(), 'wreck', () => this.spawnedAt === st && this.crashed && ctx.time - this.deadAt < 30);
  }

  update(dt: number, ctx: GameCtx) {
    if (this.local) this.simulate(dt, ctx);
    else this.remoteUpdate(ctx);
    this.animate(dt, ctx);
  }

  private simulate(dt: number, ctx: GameCtx) {
    const s = this.aspec;
    const w = ctx.world;
    if (this.crashed) return;
    const inp = this.input;
    const eng = this.engineHp > 0 ? (this.engineHp < 50 ? 0.6 : 1) : 0;
    if (!this.alive) {
      // falling wreck
      this.vel.y -= 9.81 * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.quat.multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), dt * 2));
      this.root.position.copy(this.pos); this.root.quaternion.copy(this.quat);
      if (this.pos.y < w.height(this.pos.x, this.pos.z) + 1) this.crash(ctx);
      return;
    }
    if (this.fire > 0) {
      this.fire += dt;
      this.hp -= 3 * dt;
      this.engineHp = Math.max(0, this.engineHp - 4 * dt);
      if (this.fire > 12 && Math.random() < 0.15 * dt) this.fire = 0;
      if (this.hp <= 0) { ctx.onLocalDestroyed(this, 'fire'); return; }
    }
    // ---------------- controls (mouse-aim instructor + keyboard override)
    this.throttle += (inp.throttle - this.throttle) * Math.min(1, dt * 1.5);
    let pitchIn = inp.pitch, rollIn = inp.roll, yawIn = inp.yaw;
    if (inp.aim) {
      const local = _v1.copy(inp.aim).applyQuaternion(_q.copy(this.quat).invert());
      const ang = Math.acos(Math.max(-1, Math.min(1, local.z)));
      const right = _v2.set(-1, 0, 0).applyQuaternion(this.quat);
      const bankRoll = Math.atan2(-local.x, Math.max(0.05, local.y + (local.z < 0 ? 0.6 : 0)));
      const blend = Math.min(1, ang / 0.25);
      const level = right.y * 2.2;
      if (Math.abs(rollIn) < 0.05) rollIn = THREE.MathUtils.clamp(bankRoll * 2.2 * blend + level * (1 - blend), -1, 1);
      if (Math.abs(pitchIn) < 0.05) pitchIn = local.z < 0 ? 1 : THREE.MathUtils.clamp(local.y * 7, -1, 1) * (local.y < 0 && blend > 0.6 ? 0.5 : 1);
      if (Math.abs(yawIn) < 0.05) yawIn = THREE.MathUtils.clamp(-local.x * 4, -1, 1) * (1 - blend * 0.7);
    }
    // ---------------- flight model
    const fwd = this.forward(new THREE.Vector3());
    const vmax = this.maxV, vs = this.stallV;
    const thrustA = (9.81 * 0.35 + (s.climb / 10)) * this.throttle * eng;
    const k = thrustA > 0 ? (9.81 * 0.35 + s.climb / 10) / (vmax * vmax) : 0.0001;
    const drag = (k || 1 / (vmax * vmax)) * this.speed * this.speed * (1 + Math.abs(pitchIn) * 0.35);
    this.speed += (thrustA - drag - 9.81 * fwd.y * 0.9) * dt;
    this.speed = Math.max(20, Math.min(vmax * 1.35, this.speed));
    const ctrl = THREE.MathUtils.clamp((this.speed - vs * 0.55) / (vs * 0.8), 0.15, 1) * (this.speed > vmax * 1.1 ? 0.7 : 1) * (this.pilot < 50 ? 0.7 : 1);
    const pr = (s.turn * Math.PI) / 180 * ctrl;
    const rr = (s.roll * Math.PI) / 180 * ctrl;
    const yr = pr * 0.3;
    const q = this.quat;
    q.multiply(_q.setFromAxisAngle(_v2.set(1, 0, 0), -pitchIn * pr * dt));
    q.multiply(_q.setFromAxisAngle(_v2.set(0, 0, 1), rollIn * rr * dt));
    q.multiply(_q.setFromAxisAngle(_v2.set(0, 1, 0), -yawIn * yr * dt));
    // stall: nose drops toward the velocity
    if (this.speed < vs) {
      const st = (vs - this.speed) / vs;
      const down = _v1.set(0, -1, 0);
      const target = new THREE.Quaternion().setFromUnitVectors(fwd, fwd.clone().lerp(down, 0.5).normalize()).multiply(q);
      q.slerp(target, Math.min(1, st * dt * 1.5));
    }
    q.normalize();
    this.gLoad = 1 + Math.abs(pitchIn) * ctrl * this.speed / 60;
    const nf = this.forward(new THREE.Vector3());
    const sink = this.speed < vs ? (vs - this.speed) * 0.6 : 0;
    this.vel.copy(nf).multiplyScalar(this.speed).add(_v1.set(0, -sink, 0));
    this.pos.addScaledVector(this.vel, dt);
    // soft map boundary: turn back
    const lim = 650;
    if (Math.abs(this.pos.x) > lim || Math.abs(this.pos.z) > lim) {
      const back = new THREE.Vector3(-this.pos.x, 0, -this.pos.z).normalize();
      const tq = new THREE.Quaternion().setFromUnitVectors(nf, back.setY(0.05).normalize()).multiply(q);
      q.slerp(tq, dt * 0.6);
    }
    if (this.pos.y > 1600) this.pos.y = 1600;
    // ground / building collision
    const gh = w.height(this.pos.x, this.pos.z);
    if (this.pos.y < gh + 1.2 || (this.pos.y < gh + 40 && w.isInside(this.pos.x, this.pos.z, this.pos.y)) || (w.map.water !== null && this.pos.y < w.map.water + 0.5)) {
      ctx.onLocalDestroyed(this, 'crashed');
      this.crash(ctx);
      return;
    }
    // ---------------- weapons
    this.firingGuns = false;
    s.guns.forEach((g, i) => {
      this.gunCd[i] -= dt;
      if (inp.guns && this.ammo[i] > 0 && this.gunCd[i] <= 0) {
        this.gunCd[i] = 1 / g.rate;
        this.ammo[i] = Math.max(0, this.ammo[i] - g.count);
        this.firingGuns = true;
        const ammo = AMMO[g.ammo];
        this.root.updateMatrixWorld(true);
        const conv = this.pos.clone().addScaledVector(nf, 450);
        for (let k2 = 0; k2 < g.offset.length; k2++) {
          const gp = this.model.gunPoints[this.gunIndex(i, k2)].getWorldPosition(new THREE.Vector3());
          const dir = conv.clone().sub(gp).normalize();
          dir.x += (Math.random() - 0.5) * 0.006; dir.y += (Math.random() - 0.5) * 0.006; dir.z += (Math.random() - 0.5) * 0.006;
          ctx.fireProjectile(this, ammo, gp, dir.normalize().multiplyScalar(ammo.velocity).add(this.vel));
        }
        this.lastShot = ctx.time;
      }
    });
    this.bombCd -= dt; this.rocketCd -= dt;
    if (inp.bomb && this.bombCd <= 0) {
      const b = [...this.bombs].sort((a, b2) => AMMO[b2.ammo].explosive - AMMO[a.ammo].explosive).find((x) => x.count > 0);
      if (b) {
        b.count--;
        this.bombCd = 0.35;
        const p = this.pos.clone().add(_v1.set(0, -1.5, 0).applyQuaternion(this.quat));
        ctx.fireProjectile(this, AMMO[b.ammo], p, this.vel.clone().add(new THREE.Vector3(0, -2, 0)));
      }
    }
    if (inp.rocket && this.rocketCd <= 0 && this.rockets > 0 && s.rockets) {
      this.rockets--;
      this.rocketCd = 0.25;
      const side = this.rockets % 2 ? 1 : -1;
      const p = this.pos.clone().add(_v1.set(side * s.span * 0.25, -0.5, 0.5).applyQuaternion(this.quat));
      const ra = AMMO[s.rockets.ammo];
      ctx.fireProjectile(this, ra, p, nf.clone().multiplyScalar(ra.velocity).add(this.vel));
    }
    // ---------------- rear gunner (automatic)
    this.gunnerFiring = false;
    if (s.gunner && this.gunnerHp > 0) {
      this.gunnerCd -= dt;
      let best: Aircraft | null = null, bd = 450;
      for (const o of ctx.vehicles.values()) {
        if (o.kind !== 'aircraft' || o.team === this.team || !o.alive) continue;
        const d = o.pos.distanceTo(this.pos);
        if (d < bd) {
          const rel = _v1.copy(o.pos).sub(this.pos).normalize();
          if (rel.dot(nf) < 0.2) { bd = d; best = o as Aircraft; }
        }
      }
      if (best && this.gunnerCd <= 0) {
        this.gunnerCd = 0.09;
        this.gunnerFiring = true;
        const ammo = AMMO[s.nation === 'GER' ? 'mg_792' : 'mg_127'];
        const gp = this.pos.clone().add(_v1.set(0, 1, -s.length * 0.15).applyQuaternion(this.quat));
        const tof = bd / ammo.velocity;
        const lead = best.pos.clone().addScaledVector(best.vel, tof).sub(gp).normalize();
        const spread = 0.035;
        lead.x += (Math.random() - 0.5) * spread; lead.y += (Math.random() - 0.5) * spread; lead.z += (Math.random() - 0.5) * spread;
        ctx.fireProjectile(this, ammo, gp, lead.normalize().multiplyScalar(ammo.velocity).add(this.vel));
      }
    }
    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);
  }

  private gunIndex(group: number, k: number) {
    let n = 0;
    for (let i = 0; i < group; i++) n += this.aspec.guns[i].offset.length;
    return n + k;
  }

  crash(ctx: GameCtx) {
    if (this.crashed) return;
    this.crashed = true;
    this.alive = false;
    if (!this.deadAt || ctx.time - this.deadAt > 30) this.deadAt = ctx.time;
    this.model.mats.burnt.value = 1;
    this.pos.y = Math.max(this.pos.y, ctx.world.height(this.pos.x, this.pos.z) + 0.5);
    ctx.effects.explosion(this.pos, 3.5, 'he', ctx.world.map.def.theme.dust);
    audio.explosion(this.pos, 3);
    ctx.world.scorch(this.pos.x, this.pos.z, 9);
    this.root.position.copy(this.pos);
    this.root.rotation.set(0.2, this.root.rotation.y, 0.4);
    if (this.engine) { this.engine.stop(); this.engine = null; }
    audio.siren(this.pos, false, this.sirenState);
  }

  onDestroyed(ctx: GameCtx) {
    this.alive = false;
    this.deadAt = ctx.time;
    this.fire = Math.max(this.fire, 0.01);
    this.vel.copy(this.forward(new THREE.Vector3()).multiplyScalar(this.speed * 0.8));
  }

  applyDamage(dmg: number, part: string, fireChance: number) {
    if (!this.alive) return;
    this.hp -= dmg;
    if (part === 'engine') this.engineHp = Math.max(0, this.engineHp - dmg * 2.5);
    if (part === 'pilot') this.pilot = Math.max(0, this.pilot - dmg * 4);
    if (part === 'gunner') this.gunnerHp = Math.max(0, this.gunnerHp - dmg * 4);
    if (Math.random() < fireChance) this.fire = Math.max(this.fire, 0.01);
  }

  private remoteUpdate(ctx: GameCtx) {
    const r = this.interp(ctx.time - 0.1);
    if (!r) return;
    const { a, b, k } = r;
    this.pos.lerpVectors(a.p, b.p, k);
    this.quat.slerpQuaternions(a.q, b.q, Math.min(1, k));
    this.speed = b.s;
    this.vel.copy(this.forward(_v1)).multiplyScalar(this.speed);
    const aliveNow = (b.f & 1) === 1;
    this.fire = (b.f & 2) ? Math.max(this.fire, 0.01) : 0;
    this.firingGuns = (b.f & 4) === 4;
    this.gunnerFiring = (b.f & 8) === 8;
    const crashed = (b.f & 16) === 16;
    if (!aliveNow && this.alive) { this.alive = false; this.deadAt = ctx.time; }
    if (aliveNow && !this.alive) { this.alive = true; this.crashed = false; this.model.mats.burnt.value = 0; }
    if (crashed && !this.crashed) this.crash(ctx);
    this.throttle = b.a;
    if (!this.crashed) { this.root.position.copy(this.pos); this.root.quaternion.copy(this.quat); }
    // visual tracers for remote gunfire
    if (this.firingGuns && this.alive) {
      this.remoteGunAcc += 1 / 60;
      if (this.remoteGunAcc > 0.08) {
        this.remoteGunAcc = 0;
        const g = this.aspec.guns[0];
        const ammo = AMMO[g.ammo];
        const nf = this.forward(new THREE.Vector3());
        this.root.updateMatrixWorld(true);
        const gp = this.model.gunPoints[0].getWorldPosition(new THREE.Vector3());
        ctx.fireProjectile(this, ammo, gp, nf.multiplyScalar(ammo.velocity).add(this.vel), true);
      }
    }
  }

  private animate(dt: number, ctx: GameCtx) {
    if (this.crashed) return;
    for (const p of this.model.props) {
      p.rotation.z += dt * (10 + this.throttle * 50) * (this.engineHp > 0 ? 1 : 0.1);
      const disc = p.getObjectByName('disc');
      if (disc) disc.visible = this.engineHp > 0;
    }
    this.trailAcc += dt;
    if (this.trailAcc > 0.05 && this.alive) {
      this.trailAcc = 0;
      if (this.engineHp < 50 || this.fire > 0) ctx.effects.trail(this.pos, true);
      else if (this.speed > this.maxV * 0.8 && this.gLoad > 3) {
        const s = this.aspec.span / 2;
        ctx.effects.trail(this.pos.clone().add(_v1.set(s, 0, -1).applyQuaternion(this.quat)), false);
        ctx.effects.trail(this.pos.clone().add(_v1.set(-s, 0, -1).applyQuaternion(this.quat)), false);
      }
    }
    const isMe = this.owner === ctx.myId && !this.isBot;
    if (!this.engine && audio.ctx && this.alive) this.engine = audio.engine('plane', this.aspec.engines === 2 ? 55 : 70, !isMe);
    if (this.engine) {
      this.engine.set(this.engineHp > 0 ? this.throttle : 0.05, this.engineHp > 0 ? 0.4 + this.throttle * 0.6 : 0.1, this.pos);
      if (!this.alive) { this.engine.stop(); this.engine = null; }
    }
    if (this.aspec.id === 'ju87_d') {
      const diving = this.forward(_v1).y < -0.5 && this.speed > 70 && this.alive;
      audio.siren(this.pos, diving, this.sirenState);
    }
    if ((this.firingGuns || this.gunnerFiring) && audio.ctx) {
      if (Math.random() < 0.5) audio.mg(this.pos, AMMO[this.aspec.guns[0].ammo].caliber);
    }
  }

  snapshot(): (number | string)[] {
    const f = (this.alive ? 1 : 0) | (this.fire > 0 ? 2 : 0) | (this.firingGuns ? 4 : 0) | (this.gunnerFiring ? 8 : 0) | (this.crashed ? 16 : 0);
    const r = (x: number) => Math.round(x * 100) / 100;
    const q = (x: number) => Math.round(x * 10000) / 10000;
    return [this.id, 1, r(this.pos.x), r(this.pos.y), r(this.pos.z), q(this.quat.x), q(this.quat.y), q(this.quat.z), q(this.quat.w), r(this.speed), r(this.throttle), f];
  }

  applySnapshot(s: (number | string)[], t: number) {
    const n = s as number[];
    this.buf.push({ t, p: new THREE.Vector3(n[2], n[3], n[4]), q: new THREE.Quaternion(n[5], n[6], n[7], n[8]).normalize(), a: n[10], b: 0, s: n[9], f: n[11] });
    if (this.buf.length > 10) this.buf.shift();
  }

  dispose(ctx: GameCtx) {
    ctx.scene.remove(this.root);
    if (this.engine) this.engine.stop();
    audio.siren(this.pos, false, this.sirenState);
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  }
}
