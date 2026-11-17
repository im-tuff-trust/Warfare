import * as THREE from 'three';
import { AMMO, penAt } from './data/ammo';
import { Aircraft, Tank, type Team, type Vehicle } from './entities';
import type { Difficulty } from './net/session';
import type { World } from './world/world';
import { aliveCrew } from './sim/damage';
import { getLayout } from './sim/layout';

export interface AIContext {
  time: number;
  world: World;
  vehicles: Map<string, Vehicle>;
  points: { x: number; z: number; r: number; owner: number; progress: number }[];
  isSpotted(team: Team, v: Vehicle): boolean;
  spawnZone(team: Team): THREE.Vector3;
  rules: { medkits: boolean; crewReplacement: boolean };
}

export interface Order { kind: 'attack' | 'follow' | 'defend'; until: number; targetId?: string; leaderId?: string; point?: number; }

const DIFF: Record<Difficulty, { aimErr: number; react: number; tol: number; lead: number; spot: number }> = {
  easy: { aimErr: 0.014, react: 1.4, tol: 0.012, lead: 0.55, spot: 0.8 },
  normal: { aimErr: 0.007, react: 0.8, tol: 0.0075, lead: 0.85, spot: 1 },
  hard: { aimErr: 0.0035, react: 0.45, tol: 0.005, lead: 1, spot: 1.15 },
};

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

function angDiff(a: number, b: number) { return Math.atan2(Math.sin(a - b), Math.cos(a - b)); }

/** Team-wide blackboard used by bots to cooperate. */
export class TeamBrain {
  focus: [string | null, string | null] = [null, null];
  orders: [Order | null, Order | null] = [null, null];
  pointClaims = new Map<string, number>();
  setOrder(team: Team, o: Order) { this.orders[team] = o; if (o.kind === 'attack' && o.targetId) this.focus[team] = o.targetId; }
}

export class TankBrain {
  target: Vehicle | null = null;
  goal = new THREE.Vector3();
  goalPoint = -1;
  private decideT = 0;
  private goalT = 0;
  private stuckT = 0;
  private reverseT = 0;
  private reverseSteer = 1;
  private seenT = 0;
  private aimErr = new THREE.Vector3();
  private aimErrT = 0;
  private flankSide = Math.random() < 0.5 ? 1 : -1;
  private retreating = false;
  private los = false;
  private lastPos = new THREE.Vector3();
  constructor(public tank: Tank, public diff: Difficulty, public team: TeamBrain) {}

  update(dt: number, ctx: AIContext) {
    const t = this.tank;
    const inp = t.input;
    if (!t.alive) { inp.throttle = 0; inp.fire = false; return; }
    const D = DIFF[this.diff];
    const s = t.tspec;
    const d = t.dmg;
    // ---------------- survival reflexes
    if (d.fire > 0 && d.extinguishing <= 0) t.extinguish();
    if (ctx.rules.medkits && d.medkits > 0 && d.crew.some((h) => h > 0 && h < 45)) t.useMedkit(ctx);
    const immobile = !t.mods.canMove;
    const enemyNear = this.target && this.target.alive && this.target.pos.distanceTo(t.pos) < 250 && this.los;
    if ((immobile && d.repairing <= 0) || (!enemyNear && d.repairing <= 0 && t.dmg.modules.some((h) => h <= 0))) t.startRepair();
    const crewLow = aliveCrew(d) < Math.max(2, s.crew.length - 2) || d.structure < d.maxStructure * 0.3;
    this.retreating = ctx.rules.crewReplacement && crewLow;

    // ---------------- decisions (throttled)
    this.decideT -= dt;
    if (this.decideT <= 0) {
      this.decideT = 0.5 + Math.random() * 0.3;
      this.chooseTarget(ctx, D.spot);
      this.goalT -= 0.6;
      if (this.goalT <= 0) { this.goalT = 6; this.chooseGoal(ctx); }
      if (this.target) {
        const m = _a.copy(t.pos).setY(t.pos.y + s.hull.H + 0.3);
        this.los = ctx.world.lineOfSight(m, _b.copy(this.target.center));
      } else this.los = false;
    }
    if (this.retreating) this.goal.copy(ctx.spawnZone(t.team));

    // ---------------- movement
    const tgt = this.target;
    const dist = tgt ? tgt.pos.distanceTo(t.pos) : 1e9;
    const engageRange = s.cls === 'heavy' ? 950 : s.cls === 'medium' ? 750 : 550;
    let throttle = 1, desiredHeading: number | null = null, holdPos = false;
    if (tgt && this.los && dist < engageRange && !this.retreating && tgt.kind === 'tank') {
      const toT = Math.atan2(tgt.pos.x - t.pos.x, tgt.pos.z - t.pos.z);
      if (s.cls === 'light') {
        // keep moving and flank
        desiredHeading = toT + this.flankSide * (dist < 200 ? 1.4 : 0.9);
        throttle = 1;
      } else if (dist > engageRange * 0.55) {
        // advance slowly, then stop
        desiredHeading = toT;
        throttle = s.cls === 'heavy' ? 0.35 : 0.5;
        if (dist < engageRange * 0.8) holdPos = true;
      } else {
        // angle the hull ~25-30° to the threat
        desiredHeading = toT + this.flankSide * (s.cls === 'heavy' ? 0.45 : 0.25);
        holdPos = true;
      }
    }
    const toGoal = _a.copy(this.goal).sub(t.pos);
    const goalDist = Math.hypot(toGoal.x, toGoal.z);
    if (desiredHeading === null) {
      desiredHeading = Math.atan2(toGoal.x, toGoal.z);
      const pt = this.goalPoint >= 0 ? ctx.points[this.goalPoint] : null;
      if (pt && goalDist < pt.r * 0.6) { throttle = 0; holdPos = true; }
      else if (goalDist < 12) { throttle = 0; holdPos = true; }
      else throttle = goalDist < 40 ? 0.5 : 1;
    }
    // obstacle avoidance probes
    const w = ctx.world;
    const probe = (ang: number, dd: number) => {
      const x = t.pos.x + Math.sin(ang) * dd, z = t.pos.z + Math.cos(ang) * dd;
      if (Math.abs(x) > 515 || Math.abs(z) > 515) return false;
      const gy = w.height(x, z);
      if (Math.abs(gy - t.pos.y) > dd * 0.55) return false;
      if (w.map.water !== null && gy < w.map.water - 0.6) return false;
      return !w.isInside(x, z, gy + 1);
    };
    let heading = desiredHeading;
    if (!holdPos || throttle > 0) {
      const look = 9 + Math.abs(t.speed) * 1.2;
      if (!probe(heading, look) || !probe(heading, look * 0.5)) {
        let found = false;
        for (const off of [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.7, -1.7]) {
          const o = off * this.flankSide;
          if (probe(heading + o, look) && probe(heading + o, look * 0.5)) { heading += o; found = true; break; }
        }
        if (!found) throttle = 0.3;
      }
    }
    // stuck detection
    if (Math.abs(throttle) > 0.4 && Math.abs(t.speed) < 0.6 && t.mods.canMove) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt);
    if (this.stuckT > 2.2 && this.reverseT <= 0) { this.reverseT = 1.6; this.reverseSteer = Math.random() < 0.5 ? 1 : -1; this.stuckT = 0; this.flankSide *= -1; }
    const herr = angDiff(heading, t.yaw);
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      inp.throttle = -1; inp.steer = this.reverseSteer;
    } else if (holdPos && throttle === 0) {
      inp.throttle = 0;
      inp.steer = Math.abs(herr) > 0.15 ? -THREE.MathUtils.clamp(herr * 2, -1, 1) : 0;
    } else {
      inp.throttle = Math.abs(herr) > 1.2 ? 0.15 : throttle * (1 - Math.min(0.6, Math.abs(herr) * 0.4));
      inp.steer = -THREE.MathUtils.clamp(herr * 2.2, -1, 1);
      if (holdPos) inp.throttle = Math.min(inp.throttle, throttle);
    }
    inp.brake = holdPos && throttle === 0;
    this.lastPos.copy(t.pos);

    // ---------------- gunnery
    inp.fire = false;
    if (tgt && tgt.alive && this.los && dist < 1300) {
      this.seenT += dt;
      // aim error that shrinks while tracking the same target
      this.aimErrT -= dt;
      if (this.aimErrT <= 0) {
        this.aimErrT = 1.2;
        const e = D.aimErr * dist * Math.max(0.35, 1.6 - this.seenT * 0.25);
        this.aimErr.set((Math.random() - 0.5) * e, (Math.random() - 0.5) * e * 0.6, (Math.random() - 0.5) * e);
      }
      const ammo = this.pickAmmo(tgt, dist);
      if (ammo !== t.selected && t.reload <= 0.5) t.selectAmmo(ammo);
      const v = t.loadedAmmo.velocity || 600;
      const tof = dist / v;
      const aimP = _c.copy(tgt.center);
      if (tgt.kind === 'tank') aimP.y -= (tgt as Tank).tspec.hull.H * 0.2;
      aimP.addScaledVector(tgt.vel.lengthSq() > 0 ? tgt.vel : this.estVel(tgt), tof * D.lead).add(this.aimErr);
      inp.aim = aimP.clone();
      if (this.seenT > D.react && t.reload <= 0) {
        // check gun alignment
        const mp = _a, md = _b;
        t.muzzle(mp, md);
        const want = aimP.clone().sub(mp);
        const horiz = Math.hypot(want.x, want.z);
        want.normalize();
        // compare yaw & pitch separately (pitch includes ballistic lift)
        const yawErr = Math.abs(angDiff(Math.atan2(want.x, want.z), Math.atan2(md.x, md.z)));
        const tol = D.tol + t.bloom * 0.6 + 1.2 / Math.max(50, horiz);
        if (yawErr < tol && t.bloom < (s.gun.dispersion / 1000) * t.mods.dispersion * 3 + 0.004) inp.fire = true;
      }
    } else {
      this.seenT = Math.max(0, this.seenT - dt * 2);
      // look where we are going, or at the most likely threat direction
      const look = tgt ? tgt.center.clone() : _c.copy(this.goal).setY(w.height(this.goal.x, this.goal.z) + 2);
      inp.aim = look.clone();
      if (!tgt) inp.aim.add(_a.set(Math.sin(t.yaw) * 40, 0, Math.cos(t.yaw) * 40));
    }
  }

  private estVel(v: Vehicle): THREE.Vector3 {
    if (v.kind === 'tank') { const tk = v as Tank; return new THREE.Vector3(Math.sin(tk.yaw), 0, Math.cos(tk.yaw)).multiplyScalar(tk.speed); }
    return v.vel;
  }

  private pickAmmo(tgt: Vehicle, dist: number): number {
    const t = this.tank;
    const list = t.tspec.gun.ammo.map((id) => AMMO[id]);
    if (tgt.kind !== 'tank') return list.findIndex((a) => a.kind === 'HE') >= 0 ? list.findIndex((a) => a.kind === 'HE') : 0;
    const et = tgt as Tank;
    // estimate armor facing us
    const rel = Math.abs(angDiff(Math.atan2(t.pos.x - et.pos.x, t.pos.z - et.pos.z), et.yaw));
    const armor = rel < 0.8 ? et.tspec.armor.upperFront / Math.max(0.3, Math.cos((et.tspec.hull.aUp * Math.PI) / 180)) : rel > 2.4 ? et.tspec.armor.rear : et.tspec.armor.side;
    let best = 0, bestScore = -1e9;
    list.forEach((a, i) => {
      if (a.kind === 'HE') return;
      const p = penAt(a, dist);
      const score = (p > armor * 1.1 ? 100 : p - armor) + (a.kind === 'APHE' ? 20 : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  private chooseTarget(ctx: AIContext, spotMul: number) {
    const t = this.tank;
    const focus = this.team.focus[t.team];
    let best: Vehicle | null = null, bestScore = 1e9;
    for (const v of ctx.vehicles.values()) {
      if (v.team === t.team || !v.alive || v.kind !== 'tank') continue;
      if (!ctx.isSpotted(t.team, v)) continue;
      const d = v.pos.distanceTo(t.pos);
      if (d > 1100 * spotMul) continue;
      let score = d;
      if (v.id === focus) score -= 350;
      if (v === this.target) score -= 120; // stickiness
      if (v.id === t.lastAttacker && ctx.time - t.lastAttackerTime < 10) score -= 300;
      if ((v as Tank).dmg && (v as Tank).dmg.structure < (v as Tank).dmg.maxStructure * 0.4) score -= 80;
      // threat to a teammate
      if (ctx.time - v.lastShot < 5) score -= 60;
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (best !== this.target) { this.seenT = 0; this.aimErrT = 0; }
    this.target = best;
  }

  private chooseGoal(ctx: AIContext) {
    const t = this.tank;
    const order = this.team.orders[t.team];
    if (order && order.until > ctx.time) {
      if (order.kind === 'follow' && order.leaderId) {
        const leader = ctx.vehicles.get(order.leaderId);
        if (leader && leader.alive && leader.pos.distanceTo(t.pos) < 700) {
          const off = new THREE.Vector3((Math.random() - 0.5) * 40, 0, (Math.random() - 0.5) * 40);
          this.goal.copy(leader.pos).add(off);
          this.goalPoint = -1;
          this.goalT = 2.5;
          return;
        }
      }
      if (order.kind === 'defend' && order.point !== undefined && ctx.points[order.point]) {
        this.setPoint(ctx, order.point);
        return;
      }
    }
    // pick a capture point: prefer enemy/neutral points near us, spread between teammates
    const claims = new Map<number, number>();
    for (const v of ctx.vehicles.values()) {
      if (v.team !== t.team || v === t || !v.alive || v.kind !== 'tank') continue;
      const c = this.team.pointClaims.get(v.id);
      if (c !== undefined) claims.set(c, (claims.get(c) ?? 0) + 1);
    }
    let best = 0, bs = 1e9;
    ctx.points.forEach((p, i) => {
      const d = Math.hypot(p.x - t.pos.x, p.z - t.pos.z);
      const ours = p.owner === t.team && Math.abs(p.progress) >= 0.99;
      const contested = p.owner !== t.team || Math.abs(p.progress) < 0.99;
      const score = d / 120 + (claims.get(i) ?? 0) * 1.3 + (ours ? 3.5 : 0) - (contested && p.owner !== -1 ? 0.8 : 0) + Math.random() * 0.8;
      if (score < bs) { bs = score; best = i; }
    });
    this.setPoint(ctx, best);
  }

  private setPoint(ctx: AIContext, i: number) {
    const p = ctx.points[i];
    this.goalPoint = i;
    this.team.pointClaims.set(this.tank.id, i);
    const a = Math.random() * Math.PI * 2, r = Math.random() * p.r * 0.6;
    this.goal.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
  }
}

// ============================================================ aircraft

export class PlaneBrain {
  target: Vehicle | null = null;
  private decideT = 0;
  private mode: 'patrol' | 'dogfight' | 'attack' | 'climb' = 'patrol';
  private attackPhase: 'approach' | 'dive' | 'egress' = 'approach';
  private egressT = 0;
  private aimErr = new THREE.Vector3();
  private patrol = new THREE.Vector3();
  private trackT = 0;
  constructor(public plane: Aircraft, public diff: Difficulty, public team: TeamBrain) {
    this.patrol.set((Math.random() - 0.5) * 500, 0, (Math.random() - 0.5) * 300);
  }

  update(dt: number, ctx: AIContext) {
    const p = this.plane;
    const inp = p.input;
    if (!p.alive) { inp.guns = false; return; }
    const D = DIFF[this.diff];
    const s = p.aspec;
    inp.pitch = 0; inp.roll = 0; inp.yaw = 0;
    inp.guns = false; inp.bomb = false; inp.rocket = false;
    this.decideT -= dt;
    if (this.decideT <= 0) { this.decideT = 1; this.decide(ctx); }
    const w = ctx.world;
    const fwd = p.forward(_a.clone());
    const ground = w.height(p.pos.x, p.pos.z);
    const alt = p.pos.y - ground;
    let aim = new THREE.Vector3();
    let throttle = 1;
    const tgt = this.target;
    const cruiseAlt = s.cls === 'bomber' ? (s.id === 'ju87_d' ? 650 : s.id === 'b25j' ? 320 : 260) : 380;
    if (this.mode === 'dogfight' && tgt) {
      const d = tgt.pos.distanceTo(p.pos);
      const ammo = AMMO[s.guns[0].ammo];
      const tof = d / (ammo.velocity + p.speed * 0.5);
      const lead = tgt.pos.clone().addScaledVector(tgt.vel, tof * D.lead).add(_b.set(0, 0.5 * 9.81 * tof * tof * 0.6, 0));
      this.trackT += dt;
      if (this.trackT > 1.5) { this.trackT = 0; const e = D.aimErr * d * 1.5; this.aimErr.set((Math.random() - 0.5) * e, (Math.random() - 0.5) * e, (Math.random() - 0.5) * e); }
      lead.add(this.aimErr);
      aim = lead.sub(p.pos).normalize();
      const ang = Math.acos(Math.max(-1, Math.min(1, aim.dot(fwd))));
      if (d < 550 && ang < 0.05 + D.tol * 2) inp.guns = true;
      throttle = d < 150 && aim.dot(tgt.forward(_c)) > 0.5 ? 0.6 : 1;
    } else if (this.mode === 'attack' && tgt) {
      const flat = _b.copy(tgt.pos).sub(p.pos).setY(0);
      const hd = flat.length();
      const hasBombs = p.bombs.some((b) => b.count > 0);
      const diveBomber = s.id === 'ju87_d';
      if (this.attackPhase === 'egress') {
        this.egressT -= dt;
        aim.copy(fwd).setY(0).normalize().setY(0.45).normalize();
        if (this.egressT <= 0 || alt > cruiseAlt) { this.attackPhase = 'approach'; this.mode = 'climb'; }
      } else if (diveBomber && hasBombs) {
        // dive bombing: get above the target, then steep dive
        if (this.attackPhase === 'approach') {
          const tp = tgt.pos.clone().setY(ground + cruiseAlt);
          aim = tp.sub(p.pos).normalize();
          aim.y = THREE.MathUtils.clamp(aim.y, -0.2, 0.3);
          aim.normalize();
          if (hd < Math.max(260, alt * 0.55)) this.attackPhase = 'dive';
        } else {
          aim = tgt.pos.clone().sub(p.pos).normalize();
          throttle = 0.3;
          const impact = predictBombImpact(p.pos, p.vel, w);
          if (impact && alt < 520 && impact.distanceTo(tgt.pos) < 30 + D.aimErr * 2000) inp.bomb = true;
          if (alt < 330) { inp.bomb = true; this.attackPhase = 'egress'; this.egressT = 6; }
        }
      } else if (hasBombs && s.id === 'b25j') {
        // level bombing run
        const tp = tgt.pos.clone().setY(ground + cruiseAlt);
        aim = tp.sub(p.pos).normalize();
        aim.y = THREE.MathUtils.clamp((ground + cruiseAlt - p.pos.y) / 300, -0.2, 0.2);
        aim.normalize();
        const impact = predictBombImpact(p.pos, p.vel, w);
        if (impact && impact.distanceTo(tgt.pos) < 25) inp.bomb = true;
        if (impact && hd < 80 && p.bombs.every((b) => b.count === 0)) { this.attackPhase = 'egress'; this.egressT = 5; }
        if (hd < 40 && !inp.bomb) { this.attackPhase = 'egress'; this.egressT = 6; }
      } else {
        // strafing / rocket / glide bombing run
        const d = tgt.pos.distanceTo(p.pos);
        if (this.attackPhase === 'approach' && hd > 900) {
          aim = tgt.pos.clone().setY(ground + cruiseAlt).sub(p.pos).normalize();
        } else {
          this.attackPhase = 'dive';
          const ammo = AMMO[s.guns[0].ammo];
          const tof = d / (ammo.velocity + p.speed);
          const lead = tgt.pos.clone().addScaledVector(tgt.vel, tof).add(_c.set(0, 1 + 0.5 * 9.81 * tof * tof, 0));
          aim = lead.sub(p.pos).normalize();
          const ang = Math.acos(Math.max(-1, Math.min(1, aim.dot(fwd))));
          if (d < 700 && ang < 0.06) inp.guns = true;
          if (d < 900 && d > 350 && ang < 0.05 && p.rockets > 0) inp.rocket = true;
          if (hasBombs) {
            const impact = predictBombImpact(p.pos, p.vel, w);
            if (impact && impact.distanceTo(tgt.pos) < 20) inp.bomb = true;
          }
          if (d < 180 || alt < 70) { this.attackPhase = 'egress'; this.egressT = 5; }
        }
      }
    } else {
      // patrol / climb
      const tp = this.patrol.clone().setY(w.height(this.patrol.x, this.patrol.z) + cruiseAlt);
      aim = tp.sub(p.pos).normalize();
      aim.y = THREE.MathUtils.clamp(aim.y, -0.25, 0.35);
      aim.normalize();
      if (p.pos.distanceTo(this.patrol) < 200 + p.pos.y) this.patrol.set((Math.random() - 0.5) * 700, 0, (Math.random() - 0.5) * 500);
      if (this.mode === 'climb' && alt > cruiseAlt * 0.8) this.mode = 'patrol';
    }
    // terrain avoidance: look ahead along velocity
    const ahead = p.pos.clone().addScaledVector(p.vel, 3);
    const aheadG = w.height(ahead.x, ahead.z);
    const minAlt = this.mode === 'attack' && this.attackPhase === 'dive' ? 45 : 90;
    if (ahead.y - aheadG < minAlt || alt < minAlt * 0.7) {
      aim.copy(fwd).setY(0).normalize().setY(0.8).normalize();
      inp.bomb = inp.bomb && alt > 60;
      if (this.mode === 'attack' && this.attackPhase === 'dive') { this.attackPhase = 'egress'; this.egressT = 4; }
    }
    if (p.speed < p.stallV * 1.15) { aim.y = Math.min(aim.y, -0.1); aim.normalize(); throttle = 1; }
    inp.aim = aim.normalize();
    inp.throttle = throttle;
  }

  private decide(ctx: AIContext) {
    const p = this.plane;
    const s = p.aspec;
    // threats in the air
    let air: Vehicle | null = null, ad = s.cls === 'fighter' ? 1400 : 0;
    for (const v of ctx.vehicles.values()) {
      if (v.team === p.team || !v.alive || v.kind !== 'aircraft') continue;
      const d = v.pos.distanceTo(p.pos);
      const prio = (v as Aircraft).aspec.cls === 'bomber' ? 0.8 : 1;
      if (d * prio < ad) { ad = d * prio; air = v; }
    }
    if (air && s.cls === 'fighter') {
      if (this.mode !== 'dogfight' || this.target !== air) this.trackT = 0;
      this.mode = 'dogfight'; this.target = air; return;
    }
    if (this.mode === 'attack' && this.target && this.target.alive && this.attackPhase !== 'egress') return;
    if (this.mode === 'climb') return;
    const hasOrdnance = p.bombs.some((b) => b.count > 0) || p.rockets > 0;
    const gunsLeft = p.ammo.some((a) => a > 0);
    if (!hasOrdnance && !gunsLeft) { this.mode = 'patrol'; this.target = null; return; }
    // ground attack: enemy tanks near contested points or anywhere spotted
    let best: Vehicle | null = null, bs = 1e9;
    for (const v of ctx.vehicles.values()) {
      if (v.team === p.team || !v.alive || v.kind !== 'tank') continue;
      if (!ctx.isSpotted(p.team, v) && v.pos.distanceTo(p.pos) > 900) continue;
      let score = v.pos.distanceTo(p.pos);
      for (const pt of ctx.points) if (Math.hypot(pt.x - v.pos.x, pt.z - v.pos.z) < pt.r * 2) score -= 250;
      if (v.id === this.team.focus[p.team]) score -= 400;
      if (s.cls === 'fighter' && !hasOrdnance && (v as Tank).tspec.cls === 'heavy') score += 500;
      if (score < bs) { bs = score; best = v; }
    }
    if (best && (s.cls === 'bomber' || hasOrdnance || (v2light(best)))) {
      if (this.target !== best) this.attackPhase = 'approach';
      this.mode = 'attack'; this.target = best;
    } else { this.mode = 'patrol'; this.target = null; }
  }
}

function v2light(v: Vehicle) { return v.kind === 'tank' && (v as Tank).tspec.cls !== 'heavy'; }

/** Simulate a free-falling bomb from position/velocity until it hits the ground. */
export function predictBombImpact(pos: THREE.Vector3, vel: THREE.Vector3, w: World): THREE.Vector3 | null {
  const p = pos.clone(), v = vel.clone();
  const dt = 0.1;
  for (let i = 0; i < 300; i++) {
    v.y -= 9.81 * dt;
    v.multiplyScalar(1 - 0.005 * dt);
    p.addScaledVector(v, dt);
    const g = w.height(p.x, p.z);
    if (p.y <= g) { p.y = g; return p; }
  }
  return null;
}

void getLayout;
