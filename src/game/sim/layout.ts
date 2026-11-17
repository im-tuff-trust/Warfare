import * as THREE from 'three';
import type { Role, SeatPos, TankSpec } from '../data/vehicles';
import { hullConvex, turretConvex, type Convex } from './geometry';

export type ModuleType = 'engine' | 'transmission' | 'ammo' | 'fuel' | 'breech' | 'barrel' | 'turretDrive' | 'radio' | 'trackL' | 'trackR';

export const MODULE_NAMES: Record<ModuleType, string> = {
  engine: 'Engine', transmission: 'Transmission', ammo: 'Ammo rack', fuel: 'Fuel tank', breech: 'Gun breech',
  barrel: 'Gun barrel', turretDrive: 'Turret drive', radio: 'Radio', trackL: 'Left track', trackR: 'Right track',
};

export interface SeatDef { idx: number; seat: SeatPos; roles: Role[]; pos: THREE.Vector3; inTurret: boolean; r: number; }
export interface ModuleDef { idx: number; id: string; type: ModuleType; name: string; c: THREE.Vector3; h: THREE.Vector3; inTurret: boolean; maxHp: number; rounds?: number; }

export interface TankLayout {
  hull: Convex;
  turret: Convex;
  turretBase: THREE.Vector3; // turret ring centre in hull coords
  seats: SeatDef[];
  modules: ModuleDef[];
  /** Gun trunnion in turret coords. */
  trunnion: THREE.Vector3;
}

const cache = new Map<string, TankLayout>();

export function getLayout(s: TankSpec): TankLayout {
  const c = cache.get(s.id);
  if (c) return c;
  const l = buildLayout(s);
  cache.set(s.id, l);
  return l;
}

function buildLayout(s: TankSpec): TankLayout {
  const h = s.hull, t = s.turret;
  const W2 = h.W / 2, L2 = h.L / 2;
  const turretBase = new THREE.Vector3(0, h.H, t.z);
  const ds = s.layout.driver === 'left' ? 1 : -1;
  const gs = s.layout.gunnerSide === 'left' ? 1 : -1;
  const seatY = h.clr + 0.5;
  const frontZ = s.layout.trans === 'front' ? L2 - 1.25 : L2 - 0.9;
  const seatPos = (seat: SeatPos): { p: THREE.Vector3; turret: boolean } => {
    switch (seat) {
      case 'driver': return { p: new THREE.Vector3(ds * W2 * 0.42, seatY, frontZ), turret: false };
      case 'radio': return { p: new THREE.Vector3(-ds * W2 * 0.42, seatY, frontZ), turret: false };
      case 'gunner': return { p: new THREE.Vector3(gs * t.w * 0.24, -0.3, t.l * 0.08), turret: true };
      case 'commander': return { p: new THREE.Vector3(gs * t.w * 0.2, -0.05, -t.l * 0.3), turret: true };
      case 'loader': return { p: new THREE.Vector3(-gs * t.w * 0.26, -0.35, -t.l * 0.05), turret: true };
    }
  };
  const seats: SeatDef[] = s.crew.map((c, idx) => {
    const sp = seatPos(c.seat);
    return { idx, seat: c.seat, roles: c.roles, pos: sp.p, inTurret: sp.turret, r: 0.3 };
  });

  const modules: ModuleDef[] = [];
  const add = (type: ModuleType, c: THREE.Vector3, size: THREE.Vector3, inTurret: boolean, maxHp: number, rounds?: number, suffix = '') => {
    modules.push({ idx: modules.length, id: type + suffix, type, name: MODULE_NAMES[type] + (suffix ? ' ' + suffix : ''), c, h: size.multiplyScalar(0.5), inTurret, maxHp, rounds });
  };
  const bodyH = h.H - h.clr;
  const rearTrans = s.layout.trans === 'rear';
  const engLen = h.L * 0.24;
  const engZ = rearTrans ? -L2 + 0.45 + engLen / 2 : -L2 + 0.2 + engLen / 2;
  add('engine', new THREE.Vector3(0, h.clr + bodyH * 0.42, engZ), new THREE.Vector3(h.W * 0.45, bodyH * 0.55, engLen), false, 100);
  if (rearTrans) add('transmission', new THREE.Vector3(0, h.clr + 0.32, -L2 + 0.25), new THREE.Vector3(h.W * 0.55, 0.45, 0.32), false, 100);
  else add('transmission', new THREE.Vector3(0, h.clr + 0.3, L2 - 0.42), new THREE.Vector3(h.W * 0.5, 0.45, 0.45), false, 100);
  s.layout.ammo.forEach((r, i) => {
    const high = Math.abs(r.x) >= 0.55;
    const y = r.y ?? (high ? Math.max(h.trackTop + r.h / 2, h.clr + r.h / 2) : h.clr + r.h / 2 + 0.05);
    add('ammo', new THREE.Vector3(r.x * W2, Math.min(y, h.H - r.h / 2 - 0.05), r.z * L2), new THREE.Vector3(r.w, r.h, r.l), false, 85, r.rounds, String(i + 1));
  });
  s.layout.fuel.forEach((f, i) => {
    const high = Math.abs(f.x) >= 0.55;
    const y = high ? Math.max(h.trackTop + f.h / 2, h.clr + f.h / 2) : h.clr + f.h / 2 + 0.05;
    add('fuel', new THREE.Vector3(f.x * W2, Math.min(y, h.H - f.h / 2 - 0.05), f.z * L2), new THREE.Vector3(f.w, f.h, f.l), false, 80, undefined, String(i + 1));
  });
  add('radio', new THREE.Vector3(-ds * W2 * 0.62, h.clr + bodyH * 0.65, frontZ - 0.2), new THREE.Vector3(0.28, 0.25, 0.3), false, 50);
  const trunnion = new THREE.Vector3(0, t.gunY, t.l * t.front - 0.25);
  add('breech', new THREE.Vector3(0, t.gunY - 0.02, trunnion.z - 0.5), new THREE.Vector3(0.32, 0.32, 0.9), true, 100);
  add('turretDrive', new THREE.Vector3(gs * t.w * 0.33, -0.22, t.l * 0.18), new THREE.Vector3(0.24, 0.26, 0.28), true, 80);
  // tracks are external; the boxes are only used for drawing the cutaway and HE checks
  add('trackL', new THREE.Vector3(W2 - h.trackW / 2, h.trackTop / 2, 0), new THREE.Vector3(h.trackW, h.trackTop, h.L * 0.95), false, 100);
  add('trackR', new THREE.Vector3(-W2 + h.trackW / 2, h.trackTop / 2, 0), new THREE.Vector3(h.trackW, h.trackTop, h.L * 0.95), false, 100);
  add('barrel', new THREE.Vector3(0, t.gunY, trunnion.z + s.gun.length / 2 + 0.1), new THREE.Vector3(0.2, 0.2, s.gun.length), true, 100);

  return { hull: hullConvex(s), turret: turretConvex(s), turretBase, seats, modules, trunnion };
}

/** Transform a turret-local point to hull-local given the turret yaw (rad). */
export function turretToHull(p: THREE.Vector3, yaw: number, base: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.set(p.x * c + p.z * s, p.y, -p.x * s + p.z * c).add(base);
  return out;
}

export function hullToTurret(p: THREE.Vector3, yaw: number, base: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const x = p.x - base.x, y = p.y - base.y, z = p.z - base.z;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.set(x * c - z * s, y, x * s + z * c);
  return out;
}

export function dirTurretToHull(d: THREE.Vector3, yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
}

export function dirHullToTurret(d: THREE.Vector3, yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
}
