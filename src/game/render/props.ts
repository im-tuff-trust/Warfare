import * as THREE from 'three';
import type { Building } from '../world/mapgen';
import { mulberry32 } from '../world/noise';

/** Accumulates flat-shaded, vertex-coloured triangles into a single geometry. */
export class MeshBuilder {
  pos: number[] = [];
  col: number[] = [];
  private c = new THREE.Color();
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: number, shade = 1) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.c.setHex(color).multiplyScalar(shade);
    for (let i = 0; i < 3; i++) this.col.push(this.c.r, this.c.g, this.c.b);
  }
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: number, shade = 1) {
    this.tri(a, b, c, color, shade); this.tri(a, c, d, color, shade);
  }
  /** Axis-aligned box (optionally rotated about Y around its centre). */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, color: number, rotY = 0, shadeVar = 0.06) {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const cs = Math.cos(rotY), sn = Math.sin(rotY);
    const P = (x: number, y: number, z: number) => new THREE.Vector3(cx + x * cs + z * sn, cy + y, cz - x * sn + z * cs);
    const v = [P(-hw, -hh, -hd), P(hw, -hh, -hd), P(hw, hh, -hd), P(-hw, hh, -hd), P(-hw, -hh, hd), P(hw, -hh, hd), P(hw, hh, hd), P(-hw, hh, hd)];
    const sv = () => 1 - shadeVar + Math.random() * shadeVar * 2;
    this.quad(v[0], v[3], v[2], v[1], color, 0.85 * sv()); // back (-z)
    this.quad(v[4], v[5], v[6], v[7], color, 0.92 * sv()); // front
    this.quad(v[0], v[4], v[7], v[3], color, 0.8 * sv()); // -x
    this.quad(v[1], v[2], v[6], v[5], color, 0.88 * sv()); // +x
    this.quad(v[3], v[7], v[6], v[2], color, 1.0 * sv()); // top
    this.quad(v[0], v[1], v[5], v[4], color, 0.6); // bottom
  }
  /** Gable roof over a w x d footprint, ridge along z. */
  gable(cy: number, w: number, d: number, rh: number, color: number, overhang = 0.4, rotY = 0, cx = 0, cz = 0) {
    const hw = w / 2 + overhang, hd = d / 2 + overhang;
    const cs = Math.cos(rotY), sn = Math.sin(rotY);
    const P = (x: number, y: number, z: number) => new THREE.Vector3(cx + x * cs + z * sn, cy + y, cz - x * sn + z * cs);
    const a = P(-hw, 0, -hd), b = P(hw, 0, -hd), c = P(hw, 0, hd), dd = P(-hw, 0, hd), r1 = P(0, rh, -hd), r2 = P(0, rh, hd);
    this.quad(a, dd, r2, r1, color, 0.95);
    this.quad(b, r1, r2, c, color, 0.78);
    this.tri(a, r1, b, color, 0.7);
    this.tri(dd, c, r2, color, 0.7);
  }
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color: number, shadeVar = 0.08) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      const s = 1 - shadeVar + Math.random() * shadeVar * 2;
      const tri: THREE.Vector3[] = [];
      for (let k = 0; k < 3; k++) { v.fromBufferAttribute(p, i + k).applyMatrix4(m); tri.push(v.clone()); }
      this.tri(tri[0], tri[1], tri[2], color, s);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

const DARK = 0x1c1c1e;

function windows(mb: MeshBuilder, w: number, d: number, h: number, floors: number, color = DARK, rnd: () => number) {
  for (let f = 0; f < floors; f++) {
    const y = 1.6 + f * 3.1;
    if (y + 1 > h) break;
    for (let x = -w / 2 + 2; x <= w / 2 - 1.5; x += 3) {
      if (rnd() < 0.15) continue;
      mb.box(x, y, d / 2 + 0.03, 1.1, 1.4, 0.08, color, 0, 0);
      mb.box(x, y, -d / 2 - 0.03, 1.1, 1.4, 0.08, color, 0, 0);
    }
    for (let z = -d / 2 + 2; z <= d / 2 - 1.5; z += 3) {
      if (rnd() < 0.15) continue;
      mb.box(w / 2 + 0.03, y, z, 0.08, 1.4, 1.1, color, 0, 0);
      mb.box(-w / 2 - 0.03, y, z, 0.08, 1.4, 1.1, color, 0, 0);
    }
  }
}

/** Geometry for an intact building in its local frame (base at y=0). */
export function buildingGeometry(b: Building): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const rnd = mulberry32(b.idx * 7919 + 13);
  const { w, d, h } = b;
  switch (b.type) {
    case 'house': case 'barn': case 'izba': {
      mb.box(0, h / 2 - 0.5, 0, w, h + 1, d, b.color);
      const rh = b.type === 'izba' ? w * 0.55 : w * 0.42;
      mb.gable(h + 0.5, w, d, rh, b.roof, 0.5);
      if (b.type === 'house') {
        windows(mb, w, d, h, 2, DARK, rnd);
        mb.box(w * 0.25, h + rh * 0.6, d * 0.25, 0.8, rh, 0.8, 0x6a5a50);
        mb.box(0, 1.1, d / 2 + 0.05, 1.3, 2.2, 0.1, 0x3a2a20, 0, 0);
      } else if (b.type === 'barn') {
        mb.box(0, 1.8, d / 2 + 0.05, w * 0.5, 3.6, 0.1, 0x4a3426, 0, 0);
      } else {
        windows(mb, w, d, h, 1, 0x2a2018, rnd);
        for (let y = 0.4; y < h; y += 0.5) mb.box(0, y, d / 2 + 0.04, w + 0.3, 0.06, 0.05, 0x4a3828, 0, 0);
      }
      break;
    }
    case 'church': {
      mb.box(0, h / 2 - 0.5, -2, w, h + 1, d - 4, b.color);
      mb.gable(h + 0.5, w, d - 4, w * 0.5, b.roof, 0.3, 0, 0, -2);
      const tw = w * 0.55;
      mb.box(0, (h * 2.1) / 2, d / 2 - tw / 2, tw, h * 2.1, tw, b.color);
      mb.add(new THREE.ConeGeometry(tw * 0.72, h * 1.2, 4), M(0, h * 2.1 + h * 0.6, d / 2 - tw / 2, 0, Math.PI / 4), b.roof);
      for (let z = -d / 2 + 4; z < d / 2 - tw; z += 3.5) {
        mb.box(w / 2 + 0.03, h * 0.55, z, 0.08, h * 0.5, 1.0, 0x2a3040, 0, 0);
        mb.box(-w / 2 - 0.03, h * 0.55, z, 0.08, h * 0.5, 1.0, 0x2a3040, 0, 0);
      }
      break;
    }
    case 'flat': case 'station': {
      mb.box(0, h / 2 - 0.5, 0, w, h + 1, d, b.color);
      mb.box(0, h + 0.75, 0, w + 0.2, 0.5, d + 0.2, shadeHex(b.color, 0.85));
      windows(mb, w, d, h, Math.floor(h / 3), DARK, rnd);
      if (b.type === 'station') {
        mb.box(0, h + 3, 0, 6, 6, 6, b.color);
        mb.gable(h + 6, 6, 6, 2.5, b.roof, 0.3);
        mb.box(0, h + 3.6, 3.05, 2, 2, 0.1, 0xe8e0d0, 0, 0);
      }
      break;
    }
    case 'ruin': {
      // jagged wall segments with gaps, partial floors
      const seg = (len: number, along: 'x' | 'z', off: number) => {
        const n = Math.max(2, Math.round(len / 3.2));
        const sl = len / n;
        for (let i = 0; i < n; i++) {
          if (rnd() < 0.18) continue;
          const sh = h * (0.25 + rnd() * 0.75);
          const t = -len / 2 + sl * (i + 0.5);
          if (along === 'x') mb.box(t, sh / 2 - 0.5, off, sl + 0.02, sh + 1, 0.6, b.color);
          else mb.box(off, sh / 2 - 0.5, t, 0.6, sh + 1, sl + 0.02, b.color);
          if (sh > 4 && rnd() < 0.6) {
            if (along === 'x') mb.box(t, Math.min(sh - 1.2, 2.2), off + (off > 0 ? 0.32 : -0.32), 1.1, 1.4, 0.05, DARK, 0, 0);
            else mb.box(off + (off > 0 ? 0.32 : -0.32), Math.min(sh - 1.2, 2.2), t, 0.05, 1.4, 1.1, DARK, 0, 0);
          }
        }
      };
      seg(w, 'x', d / 2 - 0.3); seg(w, 'x', -d / 2 + 0.3); seg(d, 'z', w / 2 - 0.3); seg(d, 'z', -w / 2 + 0.3);
      for (let f = 3.2; f < h * 0.7; f += 3.2) if (rnd() < 0.5) mb.box((rnd() - 0.5) * w * 0.3, f, (rnd() - 0.5) * d * 0.3, w * (0.3 + rnd() * 0.4), 0.3, d * (0.3 + rnd() * 0.4), 0x5a5550);
      for (let i = 0; i < 6; i++) mb.box((rnd() - 0.5) * w * 0.8, 0.4, (rnd() - 0.5) * d * 0.8, 1 + rnd() * 2.5, 0.6 + rnd(), 1 + rnd() * 2.5, shadeHex(b.color, 0.8), rnd() * 3);
      break;
    }
    case 'factory': {
      mb.box(0, h / 2 - 0.5, 0, w, h + 1, d, b.color);
      const teeth = Math.floor(w / 7);
      for (let i = 0; i < teeth; i++) {
        const x = -w / 2 + 3.5 + i * 7;
        const a = new THREE.Vector3(x - 3.5, h + 0.5, -d / 2), bb = new THREE.Vector3(x + 3.5, h + 0.5, -d / 2), c = new THREE.Vector3(x + 3.5, h + 3, -d / 2);
        const a2 = a.clone().setZ(d / 2), b2 = bb.clone().setZ(d / 2), c2 = c.clone().setZ(d / 2);
        mb.quad(a, a2, c2, c, b.roof, 0.9);
        mb.quad(bb, c, c2, b2, 0x8a9aa0, 0.8);
        mb.tri(a, c, bb, b.roof, 0.7); mb.tri(a2, b2, c2, b.roof, 0.7);
      }
      for (let x = -w / 2 + 3; x < w / 2 - 2; x += 4) {
        if (rnd() < 0.2) continue;
        mb.box(x, h * 0.6, d / 2 + 0.03, 2.4, h * 0.45, 0.08, 0x2a3036, 0, 0);
        mb.box(x, h * 0.6, -d / 2 - 0.03, 2.4, h * 0.45, 0.08, 0x2a3036, 0, 0);
      }
      break;
    }
    case 'chimney': {
      mb.add(new THREE.CylinderGeometry(w * 0.3, w * 0.5, h, 10), M(0, h / 2, 0), b.color);
      mb.box(0, h - 0.6, 0, w * 0.7, 1.2, w * 0.7, 0x2a2420);
      break;
    }
    case 'fortwall': {
      mb.box(0, h / 2 - 1, 0, w, h + 2, d, b.color, 0, 0.1);
      const along = w > d;
      const len = along ? w : d;
      for (let t = -len / 2 + 1; t < len / 2; t += 2.4) {
        if (along) mb.box(t, h + 1.5, 0, 1.2, 1, d, b.color);
        else mb.box(0, h + 1.5, t, d, 1, 1.2, b.color);
      }
      break;
    }
    default:
      mb.box(0, h / 2, 0, w, h, d, b.color);
  }
  return mb.build();
}

/** Rubble pile left behind after a building is destroyed. */
export function rubbleGeometry(b: Building): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const rnd = mulberry32(b.idx * 31 + 7);
  const { w, d, h } = b;
  const n = Math.min(40, 8 + Math.round((w * d) / 12));
  const base = b.type === 'barn' || b.type === 'izba' ? 0x4a3a2a : b.color;
  for (let i = 0; i < n; i++) {
    const s = 0.6 + rnd() * 2.2;
    mb.box((rnd() - 0.5) * w, rnd() * Math.min(2, h * 0.2), (rnd() - 0.5) * d, s * (1 + rnd()), s * 0.6, s, shadeHex(base, 0.6 + rnd() * 0.4), rnd() * 3, 0.2);
  }
  // a couple of standing wall stubs
  for (let i = 0; i < 3; i++) {
    const sh = h * (0.15 + rnd() * 0.3);
    const side = rnd() < 0.5;
    mb.box(side ? (rnd() - 0.5) * w : (rnd() < 0.5 ? -w / 2 : w / 2), sh / 2, side ? (rnd() < 0.5 ? -d / 2 : d / 2) : (rnd() - 0.5) * d, side ? 2 + rnd() * 3 : 0.6, sh, side ? 0.6 : 2 + rnd() * 3, shadeHex(b.color, 0.75));
  }
  // charred beams
  for (let i = 0; i < 4; i++) mb.box((rnd() - 0.5) * w * 0.6, 0.8, (rnd() - 0.5) * d * 0.6, 0.25, 0.25, 3 + rnd() * 3, 0x241c16, rnd() * 3);
  return mb.build();
}

export function hedgeGeometry(): THREE.BufferGeometry {
  // unit hedge (1x1x1) with lumpy top; instances are scaled
  const mb = new MeshBuilder();
  const rnd = mulberry32(99);
  mb.box(0, 0.4, 0, 1, 0.8, 0.9, 0x3a5222);
  for (let i = 0; i < 6; i++) {
    const g = new THREE.IcosahedronGeometry(0.5, 0);
    mb.add(g, M(-0.42 + i * 0.17, 0.62 + rnd() * 0.18, (rnd() - 0.5) * 0.15, 0, rnd() * 3, 0, 0.3, 0.55, 0.9), [0x3e5a24, 0x456428, 0x34501e][i % 3], 0.15);
  }
  return mb.build();
}

export function wallGeometry(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  mb.box(0, 0.5, 0, 1, 1, 1, 0xffffff, 0, 0.12);
  return mb.build();
}

export function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(0.6, 0);
  const p = g.getAttribute('position');
  const rnd = mulberry32(seed);
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.8 + rnd() * 0.4), p.getY(i) * (0.7 + rnd() * 0.5) + 0.3, p.getZ(i) * (0.8 + rnd() * 0.4));
  const mb = new MeshBuilder();
  mb.add(g, new THREE.Matrix4(), 0xffffff, 0.12);
  return mb.build();
}

export type TreeKind = 'deciduous' | 'pine' | 'palm' | 'birch' | 'dead';

export function treeGeometry(kind: TreeKind): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const rnd = mulberry32(kind.length * 17);
  switch (kind) {
    case 'deciduous':
      mb.add(new THREE.CylinderGeometry(0.22, 0.35, 4, 6), M(0, 2, 0), 0x4a3a28);
      for (let i = 0; i < 4; i++) mb.add(new THREE.IcosahedronGeometry(2.2, 0), M((rnd() - 0.5) * 2, 5 + rnd() * 2, (rnd() - 0.5) * 2, rnd(), rnd(), 0, 1, 0.85, 1), [0x3d5a22, 0x4a6a2a, 0x37521e, 0x557530][i], 0.15);
      break;
    case 'birch':
      mb.add(new THREE.CylinderGeometry(0.14, 0.2, 7, 6), M(0, 3.5, 0), 0xd8d4c8);
      for (let i = 0; i < 3; i++) mb.add(new THREE.IcosahedronGeometry(1.6, 0), M((rnd() - 0.5) * 1.2, 5.5 + i * 1.1, (rnd() - 0.5) * 1.2, rnd(), rnd(), 0, 0.9, 1.2, 0.9), [0x6a8a32, 0x5a7a2a, 0x7a9a3a][i], 0.15);
      break;
    case 'pine':
      mb.add(new THREE.CylinderGeometry(0.18, 0.28, 3, 6), M(0, 1.5, 0), 0x4a3424);
      for (let i = 0; i < 3; i++) mb.add(new THREE.ConeGeometry(2.4 - i * 0.6, 3.2, 7), M(0, 3 + i * 1.8, 0), 0x2e4a26, 0.12);
      break;
    case 'palm': {
      let x = 0, y = 0;
      for (let i = 0; i < 5; i++) {
        mb.add(new THREE.CylinderGeometry(0.2, 0.26, 1.6, 6), M(x, y + 0.8, 0, 0, 0, -0.06 * i), 0x7a6040);
        x += 0.1 * i; y += 1.55;
      }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        mb.add(new THREE.BoxGeometry(0.6, 0.06, 3.2), M(x + Math.sin(a) * 1.4, y - 0.3, Math.cos(a) * 1.4, 0.35, a, 0), [0x4a6a2a, 0x5a7a30][i % 2], 0.15);
      }
      break;
    }
    case 'dead':
      mb.add(new THREE.CylinderGeometry(0.12, 0.3, 5, 5), M(0, 2.5, 0, 0, 0, 0.08), 0x2e2620);
      for (let i = 0; i < 3; i++) mb.add(new THREE.CylinderGeometry(0.05, 0.1, 1.8, 4), M((rnd() - 0.5), 3 + i, 0, 0, rnd() * 3, 0.9 * (i % 2 ? 1 : -1)), 0x2e2620);
      break;
  }
  return mb.build();
}

export function shadeHex(hex: number, f: number): number {
  const c = new THREE.Color(hex).multiplyScalar(f);
  return c.getHex();
}
