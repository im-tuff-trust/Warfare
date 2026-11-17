import * as THREE from 'three';
import type { AircraftSpec, TankSpec } from '../data/vehicles';
import { clipY, frustumGeometry, hullProfile, prismGeometry, turretFootprint, type V2 } from '../sim/geometry';
import { getLayout } from '../sim/layout';

// ------------------------------------------------------------ materials

export interface VehicleMaterials { body: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; track: THREE.MeshStandardMaterial; metal: THREE.MeshStandardMaterial; burnt: { value: number }; }

function camoMaterial(base: number, camo: number | undefined, burnt: { value: number }, scale = 0.9): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.82, metalness: 0.05, emissive: new THREE.Color(base).multiplyScalar(0.22) });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.camoColor = { value: new THREE.Color(camo ?? base) };
    sh.uniforms.camoAmt = { value: camo !== undefined ? 1 : 0 };
    sh.uniforms.burnt = burnt;
    sh.uniforms.camoScale = { value: scale };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vOPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOPos = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vOPos; uniform vec3 camoColor; uniform float camoAmt; uniform float burnt; uniform float camoScale;
      float h3(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float n3(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float cn = n3(vOPos*camoScale*1.3) * 0.65 + n3(vOPos*camoScale*3.1) * 0.35;
        diffuseColor.rgb = mix(diffuseColor.rgb, camoColor, camoAmt * smoothstep(0.52, 0.58, cn));
        float grime = n3(vOPos*7.0);
        diffuseColor.rgb *= 0.9 + 0.12*grime;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06,0.055,0.05) + 0.05*grime, burnt);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n        totalEmissiveRadiance *= (1.0 - burnt);');
  };
  return m;
}

export function makeVehicleMaterials(base: number, dark: number, camo?: number): VehicleMaterials {
  const burnt = { value: 0 };
  return {
    body: camoMaterial(base, camo, burnt),
    dark: camoMaterial(dark, undefined, burnt),
    track: camoMaterial(0x2a2724, undefined, burnt, 3),
    metal: camoMaterial(0x3a3a38, undefined, burnt),
    burnt,
  };
}

const insigniaCache = new Map<string, THREE.Texture>();
function insignia(kind: 'cross' | 'star' | 'redstar'): THREE.Texture {
  const c = insigniaCache.get(kind);
  if (c) return c;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d')!;
  const star = (fill: string, stroke?: string) => {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 24 : 58, a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.lineWidth = 5; ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  if (kind === 'cross') {
    ctx.fillStyle = '#fff'; ctx.fillRect(20, 44, 88, 40); ctx.fillRect(44, 20, 40, 88);
    ctx.fillStyle = '#111'; ctx.fillRect(28, 52, 72, 24); ctx.fillRect(52, 28, 24, 72);
  } else if (kind === 'star') {
    ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.lineWidth = 6; ctx.strokeStyle = '#eee'; ctx.stroke();
    star('#eee');
  } else star('#c62020', '#f2f2f2');
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  insigniaCache.set(kind, t);
  return t;
}

function decal(kind: 'cross' | 'star' | 'redstar', size: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: insignia(kind), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  return m;
}

// ------------------------------------------------------------ tank model

export interface TankModel {
  root: THREE.Group; hull: THREE.Group; turret: THREE.Group; gun: THREE.Group; barrel: THREE.Object3D;
  muzzle: THREE.Object3D; wheelsL: THREE.Object3D[]; wheelsR: THREE.Object3D[]; trackL: THREE.Mesh; trackR: THREE.Mesh;
  mats: VehicleMaterials; exhaust: THREE.Object3D;
}

export function buildTankModel(s: TankSpec, shadows = true): TankModel {
  const h = s.hull, t = s.turret;
  const mats = makeVehicleMaterials(s.colors.base, s.colors.dark, s.colors.camo);
  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = shadows; m.receiveShadow = shadows;
    parent.add(m);
    return m;
  };
  const { pts } = hullProfile(s);
  // upper hull spans full width above the tracks (sponsons), lower hull sits between the tracks
  const upper = clipY(pts, h.trackTop - 0.05, h.H);
  const lower = clipY(pts, h.clr, h.trackTop - 0.05);
  const innerW = h.W / 2 - h.trackW;
  if (upper.length >= 3) add(hull, prismGeometry(upper, h.sponson ? h.W / 2 : innerW + 0.05), mats.body);
  if (lower.length >= 3) add(hull, prismGeometry(lower, innerW), mats.body);
  if (!h.sponson && upper.length >= 3) {
    // fenders over the tracks
    add(hull, new THREE.BoxGeometry(h.trackW + 0.06, 0.05, h.L * 0.92), mats.dark, h.W / 2 - h.trackW / 2, h.trackTop + 0.02, 0);
    add(hull, new THREE.BoxGeometry(h.trackW + 0.06, 0.05, h.L * 0.92), mats.dark, -h.W / 2 + h.trackW / 2, h.trackTop + 0.02, 0);
  }
  // tracks & road wheels
  const trackH = h.trackTop - 0.02;
  const trackGeo = new THREE.BoxGeometry(h.trackW, trackH, h.L * 0.98);
  const tp = trackGeo.getAttribute('position');
  for (let i = 0; i < tp.count; i++) {
    // round the ends of the tracks
    const y = tp.getY(i), z = tp.getZ(i);
    if (Math.abs(z) > h.L * 0.4 && y < 0) tp.setZ(i, z * 0.9);
  }
  trackGeo.computeVertexNormals();
  const trackL = add(hull, trackGeo, mats.track, h.W / 2 - h.trackW / 2, trackH / 2 + 0.02, 0);
  const trackR = add(hull, trackGeo, mats.track, -h.W / 2 + h.trackW / 2, trackH / 2 + 0.02, 0);
  const wheelsL: THREE.Object3D[] = [], wheelsR: THREE.Object3D[] = [];
  const wGeo = new THREE.CylinderGeometry(h.wheelR, h.wheelR, h.trackW * 0.5, 12);
  wGeo.rotateZ(Math.PI / 2);
  const span = h.L * 0.78;
  for (let i = 0; i < h.wheels; i++) {
    const z = -span / 2 + (span * i) / Math.max(1, h.wheels - 1);
    const wl = add(hull, wGeo, mats.dark, h.W / 2 - h.trackW / 2 + h.trackW * 0.3, h.wheelR + 0.04, z);
    const wr = add(hull, wGeo, mats.dark, -h.W / 2 + h.trackW / 2 - h.trackW * 0.3, h.wheelR + 0.04, z);
    wheelsL.push(wl); wheelsR.push(wr);
  }
  // sprockets / idlers
  const sGeo = new THREE.CylinderGeometry(h.wheelR * 0.8, h.wheelR * 0.8, h.trackW * 0.55, 10);
  sGeo.rotateZ(Math.PI / 2);
  for (const side of [1, -1]) for (const end of [1, -1]) {
    const w = add(hull, sGeo, mats.dark, side * (h.W / 2 - h.trackW / 2 + h.trackW * 0.3), trackH * 0.62, end * h.L * 0.46);
    (side > 0 ? wheelsL : wheelsR).push(w);
  }
  // hull details: hatches, headlights, exhausts, tools
  const lay = getLayout(s);
  for (const seat of lay.seats) {
    if (seat.inTurret) continue;
    add(hull, new THREE.CylinderGeometry(0.28, 0.3, 0.07, 10), mats.dark, seat.pos.x, h.H + 0.03, seat.pos.z - 0.1);
  }
  const exhaust = new THREE.Object3D();
  exhaust.position.set(h.W * 0.25, h.yRear + 0.1, -h.L / 2 - 0.1);
  hull.add(exhaust);
  add(hull, new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), mats.metal, h.W * 0.25, h.yRear + 0.1, -h.L / 2 - 0.05).rotation.x = Math.PI / 2;
  add(hull, new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), mats.metal, -h.W * 0.25, h.yRear + 0.1, -h.L / 2 - 0.05).rotation.x = Math.PI / 2;
  add(hull, new THREE.BoxGeometry(h.W * 0.5, 0.12, 0.25), mats.dark, 0, h.H + 0.06, -h.L / 2 + 0.6);
  // spare track links on the glacis
  add(hull, new THREE.BoxGeometry(h.W * 0.4, 0.06, 0.5), mats.track, 0, (h.yNose + h.H) / 2 + 0.15, h.L / 2 - (h.H - h.yNose) * Math.tan((h.aUp * Math.PI) / 180) / 2 - 0.05)
    .rotation.x = (h.aUp * Math.PI) / 180 - Math.PI / 2;
  // bow MG
  const bow = add(hull, new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), mats.metal, -(s.layout.driver === 'left' ? 1 : -1) * h.W * 0.2, (h.yNose + h.H) / 2, h.L / 2 - (h.H - h.yNose) * Math.tan((h.aUp * Math.PI) / 180) / 2 + 0.2);
  bow.rotation.x = Math.PI / 2;

  // insignia on hull sides
  const ins = s.colors.mark;
  const dl = decal(ins, 0.7); dl.position.set(h.W / 2 + 0.01, (h.trackTop + h.H) / 2 + 0.05, -h.L * 0.15); dl.rotation.y = Math.PI / 2; hull.add(dl);
  const dr = decal(ins, 0.7); dr.position.set(-h.W / 2 - 0.01, (h.trackTop + h.H) / 2 + 0.05, -h.L * 0.15); dr.rotation.y = -Math.PI / 2; hull.add(dr);

  // turret
  const turret = new THREE.Group();
  turret.position.copy(lay.turretBase);
  hull.add(turret);
  const base = turretFootprint(s);
  const cz = (t.l * t.front + -t.l * (1 - t.front)) / 2;
  const top: V2[] = base.map(([x, z]) => [x * t.taper, cz + (z - cz) * t.taper]);
  add(turret, frustumGeometry(base, top, t.h), mats.body);
  add(turret, new THREE.CylinderGeometry(t.w * 0.42, t.w * 0.45, 0.12, 16), mats.dark, 0, 0.0, 0);
  // commander cupola
  const cmd = lay.seats.find((x) => x.roles.includes('commander') && x.inTurret);
  const cpx = cmd ? cmd.pos.x : t.w * 0.2, cpz = cmd ? cmd.pos.z : -t.l * 0.25;
  add(turret, new THREE.CylinderGeometry(0.3, 0.33, 0.25, 12), mats.body, cpx, t.h + 0.12, cpz);
  add(turret, new THREE.CylinderGeometry(0.28, 0.28, 0.06, 12), mats.dark, cpx, t.h + 0.27, cpz);
  add(turret, new THREE.BoxGeometry(0.5, 0.06, 0.6), mats.dark, -cpx * 0.9, t.h + 0.03, -t.l * 0.1);
  if (s.nation === 'GER' && s.cls !== 'light') {
    // stowage bin on the turret rear
    add(turret, new THREE.BoxGeometry(t.w * 0.7, t.h * 0.55, 0.45), mats.body, 0, t.h * 0.5, -t.l * (1 - t.front) - 0.15);
  }
  const ti = decal(ins, 0.55); ti.position.set(t.w / 2 * ((1 + t.taper) / 2) + 0.02, t.h * 0.5, -t.l * 0.1); ti.rotation.y = Math.PI / 2; turret.add(ti);
  const ti2 = decal(ins, 0.55); ti2.position.set(-t.w / 2 * ((1 + t.taper) / 2) - 0.02, t.h * 0.5, -t.l * 0.1); ti2.rotation.y = -Math.PI / 2; turret.add(ti2);

  // gun
  const gun = new THREE.Group();
  gun.position.copy(lay.trunnion);
  turret.add(gun);
  const mw = t.mantletW;
  add(gun, new THREE.BoxGeometry(mw, 0.5, 0.35), mats.body, 0, 0, 0.32);
  const cal = s.gun.caliber / 1000;
  const barrelR = Math.max(0.045, cal * 0.85);
  const barrelGeo = new THREE.CylinderGeometry(barrelR, barrelR * 1.25, s.gun.length, 10);
  barrelGeo.rotateX(Math.PI / 2);
  const barrel = add(gun, barrelGeo, mats.body, 0, 0, 0.4 + s.gun.length / 2);
  // muzzle brake
  if (s.nation === 'GER' || s.id === 'm26_pershing' || s.id === 'kv1') {
    const mb = new THREE.CylinderGeometry(barrelR * 1.9, barrelR * 1.9, 0.32, 10);
    mb.rotateX(Math.PI / 2);
    add(gun, mb, mats.dark, 0, 0, 0.4 + s.gun.length + 0.08);
  }
  const coax = add(gun, new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), mats.metal, mw * 0.3, 0.05, 0.6);
  coax.rotation.x = Math.PI / 2;
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 0.4 + s.gun.length + 0.3);
  gun.add(muzzle);

  return { root, hull, turret, gun, barrel, muzzle, wheelsL, wheelsR, trackL, trackR, mats, exhaust };
}

// ------------------------------------------------------------ aircraft model

export interface AircraftModel { root: THREE.Group; props: THREE.Object3D[]; mats: VehicleMaterials; gunPoints: THREE.Object3D[]; cockpit: THREE.Group; tail: THREE.Object3D; }

export function buildAircraftModel(s: AircraftSpec, shadows = true): AircraftModel {
  const mats = makeVehicleMaterials(s.colors.base, s.colors.under);
  mats.body.side = THREE.DoubleSide; mats.dark.side = THREE.DoubleSide;
  const root = new THREE.Group();
  const L = s.length, S = s.span;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = shadows;
    parent.add(m);
    return m;
  };
  const fr = s.engines === 2 ? 0.85 : 0.62;
  // fuselage: lathe profile along z
  const prof: THREE.Vector2[] = [];
  const seg = 14;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const r = t < 0.18 ? fr * (0.55 + 0.45 * Math.sin((t / 0.18) * Math.PI / 2)) : fr * (1 - Math.pow((t - 0.18) / 0.82, 1.6) * 0.82);
    prof.push(new THREE.Vector2(Math.max(0.05, r), -L / 2 + (1 - t) * L));
  }
  const fus = new THREE.LatheGeometry(prof.reverse(), 12);
  fus.rotateX(Math.PI / 2);
  fus.rotateZ(Math.PI / 12);
  add(fus, mats.body);
  // wings (tapered)
  const wing = (span: number, rootC: number, tipC: number, thick: number, y: number, z: number, dihedral: number) => {
    const g = new THREE.BufferGeometry();
    const hs = span / 2;
    const v = [
      [0, thick, rootC / 2], [hs, thick * 0.5 + hs * dihedral, tipC / 2 - rootC * 0.15], [hs, hs * dihedral, -tipC / 2 - rootC * 0.15], [0, 0, -rootC / 2],
      [0, -thick * 0.3, rootC / 2], [hs, hs * dihedral - thick * 0.2, tipC / 2 - rootC * 0.15], [hs, hs * dihedral - thick * 0.3, -tipC / 2 - rootC * 0.15], [0, -thick * 0.4, -rootC / 2],
    ];
    const P: number[] = [];
    const quad = (a: number, b: number, c: number, d: number) => { for (const k of [a, b, c, a, c, d]) P.push(...v[k]); };
    quad(0, 1, 2, 3); quad(7, 6, 5, 4); quad(0, 4, 5, 1); quad(3, 2, 6, 7); quad(1, 5, 6, 2);
    const mir: number[] = [];
    for (let i = 0; i < P.length; i += 9) {
      mir.push(-P[i], P[i + 1], P[i + 2], -P[i + 6], P[i + 7], P[i + 8], -P[i + 3], P[i + 4], P[i + 5]);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute([...P, ...mir], 3));
    g.computeVertexNormals();
    const m = add(g, mats.body, 0, y, z);
    // underside colour panel
    const under = add(g.clone(), mats.dark, 0, y - 0.02, z);
    under.scale.set(0.995, 0.6, 0.995);
    return m;
  };
  const rootChord = L * 0.2, tipChord = L * 0.1;
  wing(S, rootChord, tipChord, 0.32, s.cls === 'bomber' && s.engines === 1 ? -0.4 : -0.3, L * 0.12, s.id === 'ju87_d' ? 0.05 : 0.04);
  // tailplane & fin
  wing(S * 0.34, L * 0.1, L * 0.06, 0.1, 0.1, -L * 0.44, 0.0);
  const fin = new THREE.BoxGeometry(0.1, L * 0.14, L * 0.12);
  const tail = add(fin, mats.body, 0, L * 0.08, -L * 0.45);
  if (s.engines === 2) {
    tail.position.x = S * 0.17;
    add(fin.clone(), mats.body, -S * 0.17, L * 0.08, -L * 0.45);
  }
  // canopy
  const canopy = new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.scale(1, 0.9, 2.6);
  const glass = new THREE.MeshStandardMaterial({ color: 0x8fb0c8, roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.55 });
  add(canopy, glass, 0, fr * 0.75, s.engines === 2 ? L * 0.25 : L * 0.02);
  // engines & props
  const props: THREE.Object3D[] = [];
  const mkProp = (x: number, y: number, z: number) => {
    const hub = new THREE.Group();
    hub.position.set(x, y, z);
    root.add(hub);
    const spinner = new THREE.ConeGeometry(0.22, 0.5, 10);
    spinner.rotateX(Math.PI / 2);
    add(spinner, mats.dark, 0, 0, 0.2, hub);
    for (let i = 0; i < 3; i++) {
      const b = add(new THREE.BoxGeometry(0.12, 1.5, 0.04), mats.metal, 0, 0, 0, hub);
      b.rotation.z = (i * Math.PI * 2) / 3;
      b.geometry.translate(0, 0.75, 0);
    }
    const disc = add(new THREE.CircleGeometry(1.6, 20), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }), 0, 0, 0.05, hub);
    disc.name = 'disc';
    props.push(hub);
  };
  if (s.engines === 2) {
    for (const side of [1, -1]) {
      const n = new THREE.CylinderGeometry(0.55, 0.45, L * 0.32, 10);
      n.rotateX(Math.PI / 2);
      add(n, mats.body, side * S * 0.17, -0.1, L * 0.18);
      mkProp(side * S * 0.17, -0.1, L * 0.18 + L * 0.17);
    }
  } else mkProp(0, 0, L / 2 + 0.1);
  if (s.id === 'ju87_d') {
    // fixed spatted landing gear
    for (const side of [1, -1]) {
      const g = add(new THREE.BoxGeometry(0.3, 1.5, 0.9), mats.body, side * 1.6, -1.2, L * 0.15);
      g.rotation.z = side * 0.15;
    }
  }
  if (s.id === 'p51d') add(new THREE.BoxGeometry(0.7, 0.5, 1.6), mats.body, 0, -fr * 0.9, -L * 0.05);
  // insignia
  const ins = s.colors.mark;
  for (const side of [1, -1]) {
    const d = decal(ins, 1.2);
    d.position.set(side * S * 0.36, 0.06 + S * 0.36 * 0.04 - 0.3, L * 0.1);
    d.rotation.x = -Math.PI / 2;
    root.add(d);
    const f = decal(ins, 0.9);
    f.position.set(side * (fr * 0.55 + 0.02), 0, -L * 0.25);
    f.rotation.y = side * Math.PI / 2;
    root.add(f);
  }
  const gunPoints: THREE.Object3D[] = [];
  for (const g of s.guns) for (const o of g.offset) {
    const p = new THREE.Object3D();
    p.position.set(o[0], o[1], o[2]);
    root.add(p);
    gunPoints.push(p);
  }
  // cockpit interior (shown only in cockpit view)
  const cockpit = new THREE.Group();
  const cz = s.engines === 2 ? L * 0.25 : L * 0.02;
  const frameMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.36, 0.06), new THREE.MeshBasicMaterial({ color: 0x2a2a28 }));
  panel.position.set(0, fr * 0.55, cz + 0.65);
  panel.rotation.x = -0.4;
  cockpit.add(panel);
  for (let i = 0; i < 5; i++) {
    const gauge = new THREE.Mesh(new THREE.CircleGeometry(0.055, 14), new THREE.MeshBasicMaterial({ color: i === 2 ? 0x606050 : 0x0a0a0a }));
    gauge.position.set(-0.36 + i * 0.18, fr * 0.56, cz + 0.61);
    gauge.rotation.x = -0.4 + Math.PI;
    gauge.rotation.y = Math.PI;
    cockpit.add(gauge);
  }
  const bar = (x: number, y: number, z: number, rx: number, rz: number, len: number) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.035, len, 0.035), frameMat);
    b.position.set(x, y, z); b.rotation.set(rx, 0, rz);
    cockpit.add(b);
  };
  bar(0.33, fr * 0.95, cz + 0.75, 0.7, 0.35, 0.75);
  bar(-0.33, fr * 0.95, cz + 0.75, 0.7, -0.35, 0.75);
  bar(0, fr * 1.15, cz + 0.2, Math.PI / 2, 0, 1.4);
  const reflector = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.1), new THREE.MeshBasicMaterial({ color: 0x88ff88, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  reflector.position.set(0, fr * 0.8, cz + 0.72);
  cockpit.add(reflector);
  cockpit.visible = false;
  root.add(cockpit);
  return { root, props, mats, gunPoints, cockpit, tail };
}
