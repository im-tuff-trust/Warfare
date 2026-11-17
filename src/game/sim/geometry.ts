import * as THREE from 'three';
import type { TankSpec } from '../data/vehicles';

// Convex armor volumes shared by hit detection, armor resolution and rendering.

export interface Plane { n: THREE.Vector3; d: number; face: string; }
export interface Convex { planes: Plane[]; }
export type V2 = [number, number];

/** Side profile of the hull in the (z, y) plane, counter-clockwise, with face labels per edge. */
export function hullProfile(s: TankSpec): { pts: V2[]; labels: string[] } {
  const h = s.hull;
  const L2 = h.L / 2;
  const zb = L2 - (h.yNose - h.clr) * Math.tan((h.aLow * Math.PI) / 180);
  const zt = L2 - (h.H - h.yNose) * Math.tan((h.aUp * Math.PI) / 180);
  const zrt = -L2 + (h.H - h.yRear) * Math.tan((h.aRear * Math.PI) / 180);
  const zrb = -L2 + (h.yRear - h.clr) * Math.tan((h.aRearLow * Math.PI) / 180);
  const pts: V2[] = [
    [zrb, h.clr], [zb, h.clr], [L2, h.yNose], [Math.max(zt, zrt + 0.5), h.H], [zrt, h.H], [-L2, h.yRear],
  ];
  const labels = ['floor', 'lowerFront', 'upperFront', 'roof', 'upperRear', 'lowerRear'];
  return { pts, labels };
}

export function convexFromProfile(pts: V2[], labels: string[], halfW: number): Convex {
  const planes: Plane[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dz = b[0] - a[0], dy = b[1] - a[1];
    const n = new THREE.Vector3(0, -dz, dy).normalize();
    planes.push({ n, d: n.y * a[1] + n.z * a[0], face: labels[i] });
  }
  planes.push({ n: new THREE.Vector3(1, 0, 0), d: halfW, face: 'left' });
  planes.push({ n: new THREE.Vector3(-1, 0, 0), d: halfW, face: 'right' });
  return { planes };
}

export function hullConvex(s: TankSpec): Convex {
  const { pts, labels } = hullProfile(s);
  return convexFromProfile(pts, labels, s.hull.W / 2);
}

/** Turret footprint polygon in (x, z), counter-clockwise seen from above. Origin = ring centre. */
export function turretFootprint(s: TankSpec): V2[] {
  const t = s.turret;
  const zf = t.l * t.front, zr = -t.l * (1 - t.front), hw = t.w / 2;
  let pts: V2[];
  switch (t.shape) {
    case 'box':
      pts = [[hw, zf], [hw, zr], [-hw, zr], [-hw, zf]];
      break;
    case 'hex':
      pts = [[hw * 0.62, zf], [hw, zf - t.l * 0.3], [hw, zr + t.l * 0.12], [hw * 0.7, zr], [-hw * 0.7, zr], [-hw, zr + t.l * 0.12], [-hw, zf - t.l * 0.3], [-hw * 0.62, zf]];
      break;
    default: {
      // cast / round: ellipse approximation with flattened front for the mantlet
      pts = [];
      const N = 12;
      const cz = (zf + zr) / 2, rz = (zf - zr) / 2;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + Math.PI / N;
        pts.push([Math.sin(a) * hw, cz + Math.cos(a) * rz]);
      }
      // order: we generated from front going toward +x (left) then rear; ensure CCW (x,z) as below
    }
  }
  // Normalize winding so that the polygon is CCW in a frame where we compute outward normals robustly later.
  return pts;
}

/** Frustum convex for turret: bottom polygon at y=0, top polygon scaled by taper at y=h. */
export function turretConvex(s: TankSpec): Convex {
  const t = s.turret;
  const base = turretFootprint(s);
  const cz = (t.l * t.front + -t.l * (1 - t.front)) / 2;
  const top = base.map(([x, z]) => [x * t.taper, cz + (z - cz) * t.taper] as V2);
  const centre = new THREE.Vector3(0, t.h / 2, cz);
  const planes: Plane[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = new THREE.Vector3(base[i][0], 0, base[i][1]);
    const b = new THREE.Vector3(base[(i + 1) % base.length][0], 0, base[(i + 1) % base.length][1]);
    const c = new THREE.Vector3(top[i][0], t.h, top[i][1]);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    if (n.dot(mid.clone().sub(centre)) < 0) n.negate();
    const face = n.z > 0.55 ? 'turretFront' : n.z < -0.55 ? 'turretRear' : 'turretSide';
    planes.push({ n, d: n.dot(a), face });
  }
  planes.push({ n: new THREE.Vector3(0, 1, 0), d: t.h, face: 'turretRoof' });
  planes.push({ n: new THREE.Vector3(0, -1, 0), d: 0, face: 'turretRing' });
  return { planes };
}

export interface ConvexHit { t: number; plane: Plane; }

/** Ray vs convex polyhedron (Cyrus-Beck). Returns entry distance and plane. */
export function rayConvex(o: THREE.Vector3, dir: THREE.Vector3, cv: Convex, maxT = Infinity): ConvexHit | null {
  let tEnter = -Infinity, tExit = maxT;
  let enterPlane: Plane | null = null;
  for (const p of cv.planes) {
    const denom = p.n.dot(dir);
    const dist = p.d - p.n.dot(o);
    if (Math.abs(denom) < 1e-9) {
      if (dist < 0) return null;
      continue;
    }
    const t = dist / denom;
    if (denom < 0) {
      if (t > tEnter) { tEnter = t; enterPlane = p; }
    } else if (t < tExit) tExit = t;
    if (tEnter > tExit) return null;
  }
  if (!enterPlane || tEnter < 0 || tEnter > maxT) return null;
  return { t: tEnter, plane: enterPlane };
}

/** Ray vs axis-aligned box (centre c, half size h). Returns entry t or null. */
export function rayBox(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, h: THREE.Vector3, maxT: number): number | null {
  let tmin = 0, tmax = maxT;
  for (let i = 0; i < 3; i++) {
    const oi = o.getComponent(i), di = d.getComponent(i), ci = c.getComponent(i), hi = h.getComponent(i);
    if (Math.abs(di) < 1e-9) {
      if (oi < ci - hi || oi > ci + hi) return null;
    } else {
      let t1 = (ci - hi - oi) / di, t2 = (ci + hi - oi) / di;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/** Ray vs sphere. */
export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number, maxT: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  if (t < 0 || t > maxT) return null;
  return Math.max(0, -b - s);
}

// ---------------- Mesh builders ----------------

/** Clip a 2D (z,y) polygon to y in [y0, y1]. */
export function clipY(pts: V2[], y0: number, y1: number): V2[] {
  const clip = (poly: V2[], keep: (p: V2) => boolean, yc: number): V2[] => {
    const out: V2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ka = keep(a), kb = keep(b);
      if (ka) out.push(a);
      if (ka !== kb) {
        const t = (yc - a[1]) / (b[1] - a[1]);
        out.push([a[0] + (b[0] - a[0]) * t, yc]);
      }
    }
    return out;
  };
  let p = clip(pts, (q) => q[1] >= y0 - 1e-6, y0);
  p = clip(p, (q) => q[1] <= y1 + 1e-6, y1);
  return p;
}

/** Extrude a convex (z,y) profile along x from -hw to +hw. */
export function prismGeometry(pts: V2[], hw: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const push = (x: number, y: number, z: number) => pos.push(x, y, z);
  const n = pts.length;
  // caps (fan)
  for (let i = 1; i < n - 1; i++) {
    // +x cap (left side)
    push(hw, pts[0][1], pts[0][0]); push(hw, pts[i + 1][1], pts[i + 1][0]); push(hw, pts[i][1], pts[i][0]);
    // -x cap
    push(-hw, pts[0][1], pts[0][0]); push(-hw, pts[i][1], pts[i][0]); push(-hw, pts[i + 1][1], pts[i + 1][0]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    push(hw, a[1], a[0]); push(-hw, a[1], a[0]); push(-hw, b[1], b[0]);
    push(hw, a[1], a[0]); push(-hw, b[1], b[0]); push(hw, b[1], b[0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fixWinding(g);
  g.computeVertexNormals();
  return g;
}

/** Frustum between bottom polygon (x,z) at y=0 and top polygon at y=h. */
export function frustumGeometry(bottom: V2[], top: V2[], h: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = bottom.length;
  const P = (p: V2, y: number) => pos.push(p[0], y, p[1]);
  for (let i = 1; i < n - 1; i++) {
    P(top[0], h); P(top[i], h); P(top[i + 1], h);
    P(bottom[0], 0); P(bottom[i + 1], 0); P(bottom[i], 0);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    P(bottom[i], 0); P(bottom[j], 0); P(top[j], h);
    P(bottom[i], 0); P(top[j], h); P(top[i], h);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fixWinding(g);
  g.computeVertexNormals();
  return g;
}

/** Make every triangle of a convex, non-indexed geometry face outward from the centroid. */
export function fixWinding(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const arr = p.array as Float32Array;
  let cx = 0, cy = 0, cz = 0;
  const cnt = p.count;
  for (let i = 0; i < cnt; i++) { cx += arr[i * 3]; cy += arr[i * 3 + 1]; cz += arr[i * 3 + 2]; }
  cx /= cnt; cy /= cnt; cz /= cnt;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  for (let i = 0; i < cnt; i += 3) {
    a.fromArray(arr, i * 3); b.fromArray(arr, i * 3 + 3); c.fromArray(arr, i * 3 + 6);
    n.subVectors(b, a).cross(m.subVectors(c, a));
    m.set((a.x + b.x + c.x) / 3 - cx, (a.y + b.y + c.y) / 3 - cy, (a.z + b.z + c.z) / 3 - cz);
    if (n.dot(m) < 0) {
      for (let k = 0; k < 3; k++) {
        const t = arr[(i + 1) * 3 + k];
        arr[(i + 1) * 3 + k] = arr[(i + 2) * 3 + k];
        arr[(i + 2) * 3 + k] = t;
      }
    }
  }
}
