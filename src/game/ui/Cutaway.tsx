'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { TankSpec } from '../data/vehicles';
import { hullProfile, turretFootprint } from '../sim/geometry';
import { getLayout, turretToHull } from '../sim/layout';
import type { HitReport } from '../sim/damage';

export interface CutawayProps {
  spec: TankSpec;
  crew: number[];
  modules: number[]; // hp values (absolute)
  turretYaw: number;
  report?: HitReport | null;
  view: 'top' | 'side';
  width: number; height: number;
  labels?: boolean;
  highlight?: number | null; // module index
}

const ROLE_LETTER: Record<string, string> = { commander: 'C', driver: 'D', gunner: 'G', loader: 'L', radio: 'R' };

export function hpColor(f: number, alpha = 1): string {
  if (f <= 0) return `rgba(120,20,20,${alpha})`;
  if (f < 0.34) return `rgba(230,70,40,${alpha})`;
  if (f < 0.67) return `rgba(240,170,40,${alpha})`;
  if (f < 1) return `rgba(200,220,70,${alpha})`;
  return `rgba(90,200,110,${alpha})`;
}

/** Draws a technical cutaway of a tank with crew, components and an optional hit trace. */
export function Cutaway(p: CutawayProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = p.width * dpr; cv.height = p.height * dpr;
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(c, p);
  });
  return <canvas ref={ref} style={{ width: p.width, height: p.height, display: 'block' }} />;
}

function draw(c: CanvasRenderingContext2D, p: CutawayProps) {
  const { spec, view, width: W, height: H } = p;
  const lay = getLayout(spec);
  const h = spec.hull, t = spec.turret;
  c.clearRect(0, 0, W, H);
  const pad = 14;
  const extentZ = h.L / 2 + spec.gun.length * 0.45;
  const sc = view === 'top'
    ? Math.min((W - pad * 2) / (h.L + spec.gun.length * 0.9), (H - pad * 2) / (h.W + 0.4))
    : Math.min((W - pad * 2) / (h.L + spec.gun.length * 0.9), (H - pad * 2) / (h.H + t.h + 0.6));
  const cx = W / 2 - (spec.gun.length * 0.45 * sc) / 2;
  const cy = view === 'top' ? H / 2 : H - pad - 4;
  void extentZ;
  const yaw = p.report ? p.report.turretYaw : p.turretYaw;
  // projections: hull-local (x,y,z) -> canvas
  const P = (v: THREE.Vector3 | [number, number, number]): [number, number] => {
    const x = Array.isArray(v) ? v[0] : v.x, y = Array.isArray(v) ? v[1] : v.y, z = Array.isArray(v) ? v[2] : v.z;
    return view === 'top' ? [cx + z * sc, cy - x * sc] : [cx + z * sc, cy - y * sc];
  };
  // grid
  c.strokeStyle = 'rgba(140,170,140,0.08)';
  c.lineWidth = 1;
  for (let x = 0; x < W; x += 12) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y < H; y += 12) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

  c.lineJoin = 'round';
  // ---------------- hull outline
  c.strokeStyle = 'rgba(200,215,190,0.85)';
  c.fillStyle = 'rgba(70,85,60,0.35)';
  c.lineWidth = 1.6;
  if (view === 'top') {
    const [x0, y0] = P([h.W / 2, 0, -h.L / 2]);
    c.beginPath(); c.rect(x0, y0, h.L * sc, h.W * sc); c.fill(); c.stroke();
    // tracks
    const tl = lay.modules.find((m) => m.type === 'trackL')!, tr = lay.modules.find((m) => m.type === 'trackR')!;
    for (const m of [tl, tr]) {
      const f = p.modules[m.idx] / m.maxHp;
      const [a, b] = P([m.c.x + m.h.x, 0, -h.L / 2]);
      c.fillStyle = f <= 0 ? 'rgba(200,40,30,0.55)' : 'rgba(40,40,36,0.6)';
      c.fillRect(a, b, h.L * sc, h.trackW * sc);
      c.strokeStyle = 'rgba(200,215,190,0.35)'; c.strokeRect(a, b, h.L * sc, h.trackW * sc);
      if (f <= 0) { c.fillStyle = '#ff6a50'; c.font = '600 9px var(--font-ui), sans-serif'; c.fillText('TRACK BROKEN', a + 6, b + h.trackW * sc - 3); }
    }
    // turret footprint rotated
    const fp = turretFootprint(spec);
    c.beginPath();
    fp.forEach(([x, z], i) => {
      const w = turretToHull(new THREE.Vector3(x, 0, z), yaw, lay.turretBase);
      const [a, b] = P(w);
      if (i === 0) c.moveTo(a, b); else c.lineTo(a, b);
    });
    c.closePath();
    c.fillStyle = 'rgba(90,105,75,0.35)'; c.fill();
    c.strokeStyle = 'rgba(220,230,210,0.9)'; c.stroke();
    // barrel
    const g0 = turretToHull(new THREE.Vector3(0, 0, lay.trunnion.z), yaw, lay.turretBase);
    const g1 = turretToHull(new THREE.Vector3(0, 0, lay.trunnion.z + spec.gun.length + 0.4), yaw, lay.turretBase);
    c.lineWidth = Math.max(2, spec.gun.caliber / 18);
    const bm = lay.modules.find((m) => m.type === 'barrel')!;
    c.strokeStyle = p.modules[bm.idx] <= 0 ? 'rgba(230,70,40,0.9)' : 'rgba(220,230,210,0.9)';
    c.beginPath(); c.moveTo(...P(g0)); c.lineTo(...P(g1)); c.stroke();
    c.lineWidth = 1.6;
  } else {
    const { pts } = hullProfile(spec);
    c.beginPath();
    pts.forEach(([z, y], i) => { const [a, b] = P([0, y, z]); if (i === 0) c.moveTo(a, b); else c.lineTo(a, b); });
    c.closePath(); c.fill(); c.stroke();
    // running gear
    c.fillStyle = 'rgba(40,40,36,0.6)';
    const [ta, tb] = P([0, h.trackTop, -h.L / 2]);
    c.fillRect(ta, tb, h.L * sc, h.trackTop * sc);
    c.strokeStyle = 'rgba(200,215,190,0.3)';
    for (let i = 0; i < h.wheels; i++) {
      const z = -h.L * 0.39 + (h.L * 0.78 * i) / Math.max(1, h.wheels - 1);
      const [a, b] = P([0, h.wheelR + 0.04, z]);
      c.beginPath(); c.arc(a, b, h.wheelR * sc, 0, Math.PI * 2); c.stroke();
    }
    // turret side silhouette
    const fz = t.l * t.front, rz = -t.l * (1 - t.front);
    const cs = Math.cos(yaw);
    const zf = lay.turretBase.z + fz * Math.abs(cs) + (t.w / 2) * Math.abs(Math.sin(yaw));
    const zr = lay.turretBase.z + rz * Math.abs(cs) - (t.w / 2) * Math.abs(Math.sin(yaw));
    c.beginPath();
    const [a1, b1] = P([0, h.H, zr]), [a2, b2] = P([0, h.H, zf]);
    const [a3, b3] = P([0, h.H + t.h, lay.turretBase.z + (zf - lay.turretBase.z) * t.taper]), [a4, b4] = P([0, h.H + t.h, lay.turretBase.z + (zr - lay.turretBase.z) * t.taper]);
    c.moveTo(a1, b1); c.lineTo(a2, b2); c.lineTo(a3, b3); c.lineTo(a4, b4); c.closePath();
    c.fillStyle = 'rgba(90,105,75,0.35)'; c.fill(); c.strokeStyle = 'rgba(220,230,210,0.9)'; c.stroke();
    const gy = h.H + t.gunY;
    const gz0 = lay.turretBase.z + lay.trunnion.z * cs;
    const gz1 = gz0 + (spec.gun.length + 0.4) * cs;
    c.lineWidth = Math.max(2, spec.gun.caliber / 18);
    c.beginPath(); c.moveTo(...P([0, gy, gz0])); c.lineTo(...P([0, gy, gz1])); c.stroke();
    c.lineWidth = 1.6;
  }

  // ---------------- modules
  c.font = '500 9px var(--font-ui), sans-serif';
  for (const m of lay.modules) {
    if (m.type === 'trackL' || m.type === 'trackR' || m.type === 'barrel') continue;
    const centre = m.inTurret ? turretToHull(m.c, yaw, lay.turretBase) : m.c;
    const f = p.modules[m.idx] / m.maxHp;
    const hx = view === 'top' ? m.h.z : m.h.z, hy = view === 'top' ? m.h.x : m.h.y;
    const [a, b] = P(centre);
    const hit = p.report?.modulesHit.find((x) => x.idx === m.idx);
    const isAmmo = m.type === 'ammo';
    c.fillStyle = isAmmo ? (f <= 0 ? 'rgba(120,30,20,0.75)' : `rgba(190,120,40,${0.35 + 0.4 * f})`) : hpColor(f, 0.38);
    c.strokeStyle = hit ? '#ff5040' : p.highlight === m.idx ? '#ffffff' : hpColor(f, 0.95);
    c.lineWidth = hit || p.highlight === m.idx ? 2.2 : 1.1;
    const rw = hx * 2 * sc, rh = hy * 2 * sc;
    c.fillRect(a - rw / 2, b - rh / 2, rw, rh);
    c.strokeRect(a - rw / 2, b - rh / 2, rw, rh);
    if (isAmmo) {
      // shells
      c.fillStyle = f <= 0 ? 'rgba(60,20,10,0.8)' : 'rgba(230,190,90,0.85)';
      const n = Math.max(1, Math.min(6, Math.floor(rw / 5)));
      for (let i = 0; i < n; i++) c.fillRect(a - rw / 2 + 2 + i * ((rw - 4) / n), b - rh / 2 + 2, Math.max(1.5, (rw - 4) / n - 1.5), Math.max(2, rh - 4));
    }
    if (p.labels && (view === 'top' || !isAmmo)) {
      c.fillStyle = 'rgba(235,240,225,0.9)';
      c.textAlign = 'center';
      const label = m.type === 'engine' ? 'ENGINE' : m.type === 'transmission' ? 'TRANS' : m.type === 'ammo' ? 'AMMO' : m.type === 'fuel' ? 'FUEL' : m.type === 'breech' ? 'BREECH' : m.type === 'turretDrive' ? 'DRIVE' : m.type === 'radio' ? 'RADIO' : '';
      if (rw > 22) c.fillText(label, a, b + 3);
    }
  }

  // ---------------- crew
  c.textAlign = 'center';
  for (const s of lay.seats) {
    const pos = s.inTurret ? turretToHull(s.pos, yaw, lay.turretBase) : s.pos;
    const [a, b] = P(pos);
    const hp = p.crew[s.idx] ?? 100;
    const f = hp / 100;
    const r = Math.max(5, s.r * sc * 0.85);
    const hit = p.report?.crewHit.find((x) => x.seat === s.idx);
    c.beginPath(); c.arc(a, b, r, 0, Math.PI * 2);
    c.fillStyle = hp <= 0 ? 'rgba(20,20,20,0.9)' : hpColor(f, 0.9);
    c.fill();
    c.lineWidth = hit ? 2.5 : 1.2;
    c.strokeStyle = hit ? '#ff3a2a' : 'rgba(0,0,0,0.6)';
    c.stroke();
    c.fillStyle = hp <= 0 ? '#ff5a4a' : '#101410';
    c.font = `700 ${Math.max(8, r * 0.95)}px var(--font-ui), sans-serif`;
    c.fillText(hp <= 0 ? '✕' : s.roles.map((x) => ROLE_LETTER[x]).join(''), a, b + Math.max(3, r * 0.35));
  }

  // ---------------- hit trace
  const rep = p.report;
  if (rep) {
    const ip = P(rep.point);
    const d = new THREE.Vector3(...rep.dir);
    const pre = new THREE.Vector3(...rep.point).addScaledVector(d, -2.2);
    c.strokeStyle = rep.result === 'ricochet' ? '#ffd23f' : '#ff3a2a';
    c.lineWidth = 2;
    c.setLineDash([5, 3]);
    c.beginPath(); c.moveTo(...P(pre)); c.lineTo(...ip); c.stroke();
    c.setLineDash([]);
    if (rep.result === 'ricochet') {
      const out = new THREE.Vector3(...rep.point).addScaledVector(d, 1.4).setY(rep.point[1] + 1.2);
      c.beginPath(); c.moveTo(...ip); c.lineTo(...P(out)); c.stroke();
    }
    // fragments
    c.strokeStyle = 'rgba(255,150,60,0.75)';
    c.lineWidth = 1;
    for (let i = 0; i + 5 < rep.rays.length; i += 6) {
      c.beginPath(); c.moveTo(...P([rep.rays[i], rep.rays[i + 1], rep.rays[i + 2]])); c.lineTo(...P([rep.rays[i + 3], rep.rays[i + 4], rep.rays[i + 5]])); c.stroke();
    }
    if (rep.shellPath.length === 6) {
      c.strokeStyle = '#ff2a1a'; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(...P([rep.shellPath[0], rep.shellPath[1], rep.shellPath[2]])); c.lineTo(...P([rep.shellPath[3], rep.shellPath[4], rep.shellPath[5]])); c.stroke();
    }
    // impact star
    c.fillStyle = rep.result === 'pen' || rep.result === 'blast' ? '#ff3a2a' : rep.result === 'partial' ? '#ff9a2a' : rep.result === 'ricochet' ? '#ffd23f' : '#9ad0ff';
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? 3 : 8, a = (i * Math.PI) / 5;
      c.lineTo(ip[0] + Math.cos(a) * rr, ip[1] + Math.sin(a) * rr);
    }
    c.closePath(); c.fill();
    c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
  }
  // view label
  c.fillStyle = 'rgba(200,215,190,0.55)';
  c.font = '600 9px var(--font-ui), sans-serif';
  c.textAlign = 'left';
  c.fillText(view === 'top' ? 'TOP VIEW · FRONT →' : 'SIDE VIEW · FRONT →', 6, 11);
}
