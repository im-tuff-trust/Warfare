import * as THREE from 'three';
import type { Game } from '../game';
import type { Aircraft, Tank } from '../entities';
import { HALF, PLAY } from '../world/mapgen';

const _p = new THREE.Vector3();

function project(g: Game, p: THREE.Vector3, w: number, h: number): { x: number; y: number; behind: boolean } {
  _p.copy(p).project(g.camera);
  return { x: (_p.x * 0.5 + 0.5) * w, y: (-_p.y * 0.5 + 0.5) * h, behind: _p.z > 1 };
}

const TEAM_COL = ['#5aa9ff', '#ff5a4a'];

export function drawOverlay(g: Game, c: CanvasRenderingContext2D, w: number, h: number) {
  c.clearRect(0, 0, w, h);
  const me = g.me;
  const cx = w / 2, cy = h / 2;
  c.lineWidth = 1.5;
  c.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  c.textAlign = 'center';

  // ---------------- vehicle markers
  for (const v of g.vehicles.values()) {
    if (v === me || !v.root.visible) continue;
    const ally = me ? v.team === me.team : v.team === 0;
    if (!ally && !g.mySpotted.has(v.id)) continue;
    if (!v.alive) continue;
    const top = v.kind === 'tank' ? v.pos.clone().setY(v.pos.y + (v as Tank).tspec.hull.H + 2.2) : v.pos.clone().setY(v.pos.y + 4);
    const s = project(g, top, w, h);
    if (s.behind || s.x < -50 || s.x > w + 50 || s.y < -50 || s.y > h + 50) continue;
    const dist = me ? Math.round(me.pos.distanceTo(v.pos)) : 0;
    const col = TEAM_COL[v.team];
    c.fillStyle = col;
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.beginPath();
    if (ally) { c.arc(s.x, s.y, 4, 0, Math.PI * 2); }
    else { c.moveTo(s.x - 6, s.y - 8); c.lineTo(s.x + 6, s.y - 8); c.lineTo(s.x, s.y); c.closePath(); }
    c.fill(); c.stroke();
    if (dist < (ally ? 450 : 750)) {
      c.fillStyle = ally ? 'rgba(190,220,255,0.9)' : 'rgba(255,200,190,0.95)';
      c.fillText(`${v.spec.name.split(' ').slice(0, 2).join(' ')}${ally ? '' : '  ' + dist + 'm'}`, s.x, s.y - 12);
      if (dist < 250) { c.fillStyle = 'rgba(255,255,255,0.7)'; c.fillText(v.name, s.x, s.y - 24); }
    }
    // lead indicator for aircraft
    if (me && me.kind === 'aircraft' && v.kind === 'aircraft' && !ally && dist < 1000) {
      const tof = dist / 850;
      const lead = v.pos.clone().addScaledVector(v.vel, tof);
      const ls = project(g, lead, w, h);
      if (!ls.behind) { c.strokeStyle = '#ffcf40'; c.beginPath(); c.arc(ls.x, ls.y, 7, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.moveTo(s.x, s.y + 8); c.lineTo(ls.x, ls.y); c.setLineDash([3, 4]); c.stroke(); c.setLineDash([]); }
    }
  }

  // ---------------- capture points
  g.points.forEach((p, i) => {
    const s = project(g, new THREE.Vector3(p.x, g.world.height(p.x, p.z) + 12, p.z), w, h);
    if (s.behind) return;
    const col = p.owner === 0 ? TEAM_COL[0] : p.owner === 1 ? TEAM_COL[1] : '#dddddd';
    c.beginPath();
    c.arc(s.x, s.y, 13, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,0,0,0.45)'; c.fill();
    c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    if (Math.abs(p.progress) > 0.01 && Math.abs(p.progress) < 1) {
      c.beginPath(); c.strokeStyle = p.progress > 0 ? TEAM_COL[0] : TEAM_COL[1]; c.lineWidth = 3;
      c.arc(s.x, s.y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.abs(p.progress)); c.stroke();
    }
    c.lineWidth = 1.5;
    c.fillStyle = col; c.font = '800 13px ui-sans-serif, system-ui';
    c.fillText(String.fromCharCode(65 + i), s.x, s.y + 4.5);
    if (me) { c.font = '600 10px ui-sans-serif, system-ui'; c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillText(Math.round(Math.hypot(me.pos.x - p.x, me.pos.z - p.z)) + 'm', s.x, s.y + 28); }
    c.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  });

  if (!me || !me.alive) return;

  // ---------------- tank reticles
  if (me.kind === 'tank') {
    const t = me as Tank;
    const gunner = g.view === 'gunner';
    // camera crosshair
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 1.5;
    if (gunner) {
      // optical sight: chevrons and range stadia
      c.strokeStyle = 'rgba(20,20,20,0.9)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(cx - w * 0.3, cy); c.lineTo(cx - 40, cy);
      c.moveTo(cx + 40, cy); c.lineTo(cx + w * 0.3, cy);
      c.moveTo(cx, cy + 40); c.lineTo(cx, cy + h * 0.3);
      c.stroke();
      c.beginPath(); c.moveTo(cx - 12, cy + 12); c.lineTo(cx, cy); c.lineTo(cx + 12, cy + 12); c.stroke();
      c.fillStyle = 'rgba(20,20,20,0.9)';
      c.font = '600 10px ui-monospace, monospace';
      for (let i = 1; i <= 4; i++) { const y = cy + i * 22; c.fillRect(cx - 6, y, 12, 1.5); c.fillText(String(i * 4), cx + 20, y + 4); }
      // vignette
      const grad = c.createRadialGradient(cx, cy, Math.min(w, h) * 0.32, cx, cy, Math.min(w, h) * 0.62);
      grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.92)');
      c.fillStyle = grad; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,0.85)'; c.font = '600 12px ui-monospace, monospace'; c.textAlign = 'left';
      c.fillText(`${t.tspec.gun.name}  ×${g.zoom.toFixed(1)}`, 24, h - 24);
      const range = Math.round(t.pos.distanceTo(g.aimPoint));
      c.fillText(`RANGE ${range} m`, 24, h - 42);
      c.textAlign = 'center';
    } else {
      c.beginPath();
      c.moveTo(cx - 10, cy); c.lineTo(cx - 4, cy); c.moveTo(cx + 4, cy); c.lineTo(cx + 10, cy);
      c.moveTo(cx, cy - 10); c.lineTo(cx, cy - 4); c.moveTo(cx, cy + 4); c.lineTo(cx, cy + 10);
      c.stroke();
    }
    // gun reticle (actual gun direction + dispersion), coloured by penetration estimate
    if (g.gunPoint) {
      const s = project(g, g.gunPoint, w, h);
      if (!s.behind) {
        const dist = Math.max(30, t.pos.distanceTo(g.gunPoint));
        const fovR = (g.camera.fov * Math.PI) / 180;
        const rpx = Math.max(6, ((t.bloom * dist) / (2 * dist * Math.tan(fovR / 2))) * h);
        const pv = g.penPreview;
        const col = pv ? (pv.verdict === 'pen' ? '#46e05a' : pv.verdict === 'maybe' ? '#ffd23f' : '#ff4a3a') : 'rgba(255,255,255,0.9)';
        c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 3.5;
        c.beginPath(); c.arc(s.x, s.y, rpx, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = col; c.lineWidth = 1.8;
        c.beginPath(); c.arc(s.x, s.y, rpx, 0, Math.PI * 2); c.stroke();
        // reload arc
        const g2 = t.tspec.gun;
        const total = t.clip > 0 && g2.clip ? g2.clip.interval : g2.reload;
        const frac = t.reload <= 0 ? 1 : 1 - t.reload / total;
        c.strokeStyle = frac >= 1 ? 'rgba(120,255,140,0.9)' : 'rgba(255,190,80,0.9)';
        c.lineWidth = 3;
        c.beginPath(); c.arc(s.x, s.y, rpx + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); c.stroke();
        if (pv && pv.verdict !== 'none') {
          c.fillStyle = col; c.font = '700 11px ui-sans-serif, system-ui';
          c.fillText(`${pv.section}: ${pv.effective} mm eff. / ${pv.pen} mm pen`, s.x, s.y + rpx + 22);
        }
      }
    }
  } else {
    // ---------------- aircraft: mouse-aim circle, flight path marker, bomb sight
    const a = me as Aircraft;
    const aim = project(g, a.pos.clone().addScaledVector(a.aimDir, 500), w, h);
    if (!aim.behind) { c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 1.5; c.beginPath(); c.arc(aim.x, aim.y, 10, 0, Math.PI * 2); c.stroke(); }
    if (g.gunPoint) {
      const s = project(g, g.gunPoint, w, h);
      if (!s.behind) {
        c.strokeStyle = '#8dff8d'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(s.x - 14, s.y); c.lineTo(s.x - 5, s.y); c.moveTo(s.x + 5, s.y); c.lineTo(s.x + 14, s.y); c.moveTo(s.x, s.y - 5); c.lineTo(s.x, s.y - 12); c.stroke();
        c.beginPath(); c.arc(s.x, s.y, 2, 0, Math.PI * 2); c.stroke();
      }
    }
    if (g.bombImpact) {
      const s = project(g, g.bombImpact, w, h);
      if (!s.behind) {
        c.strokeStyle = '#ffb040'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(s.x - 9, s.y - 9); c.lineTo(s.x + 9, s.y + 9); c.moveTo(s.x + 9, s.y - 9); c.lineTo(s.x - 9, s.y + 9); c.stroke();
        c.fillStyle = '#ffb040'; c.fillText('BOMB', s.x, s.y + 22);
      }
    }
  }

  // ---------------- hit markers (my shots)
  const now = g.time;
  g.hitMarkers.forEach((m, i) => {
    const age = now - m.time;
    const a = Math.max(0, 1 - age / 1.6);
    const col = m.result === 'pen' ? `rgba(70,230,90,${a})` : m.result === 'partial' || m.result === 'module' ? `rgba(255,210,60,${a})` : `rgba(255,90,70,${a})`;
    c.strokeStyle = col; c.lineWidth = 2.5;
    const r = 10 + age * 6;
    c.beginPath(); c.moveTo(cx - r, cy - r); c.lineTo(cx - r / 2, cy - r / 2); c.moveTo(cx + r, cy - r); c.lineTo(cx + r / 2, cy - r / 2);
    c.moveTo(cx - r, cy + r); c.lineTo(cx - r / 2, cy + r / 2); c.moveTo(cx + r, cy + r); c.lineTo(cx + r / 2, cy + r / 2); c.stroke();
    c.fillStyle = col; c.font = '800 13px ui-sans-serif, system-ui';
    c.fillText(m.text, cx, cy - 46 - i * 16);
  });

  // ---------------- incoming damage direction
  for (const d of g.damageIndicators) {
    const age = now - d.time;
    const a = Math.max(0, 1 - age / 3);
    const to = d.from.clone().sub(me.pos);
    const camDir = g.camera.getWorldDirection(new THREE.Vector3());
    const ang = Math.atan2(to.x, to.z) - Math.atan2(camDir.x, camDir.z);
    const R = Math.min(w, h) * 0.22;
    c.strokeStyle = d.pen ? `rgba(255,50,40,${a})` : `rgba(255,200,80,${a})`;
    c.lineWidth = 6;
    c.beginPath();
    const base = -Math.PI / 2 - ang;
    c.arc(cx, cy, R, base - 0.25, base + 0.25);
    c.stroke();
  }
}

export function drawMinimap(g: Game, cv: HTMLCanvasElement) {
  const c = cv.getContext('2d');
  if (!c) return;
  const S = cv.width;
  const sc = S / (PLAY * 2 + 40);
  const toM = (x: number, z: number): [number, number] => [S / 2 - x * sc, S / 2 - z * sc];
  c.clearRect(0, 0, S, S);
  c.fillStyle = 'rgba(16,18,14,0.78)';
  c.fillRect(0, 0, S, S);
  // terrain snapshot
  const tex = g.world.groundCanvas;
  if (tex) {
    c.save();
    c.globalAlpha = 0.85;
    // ground canvas covers [-HALF, HALF]; map is mirrored so north (+z) is up and +x (west) is left
    const full = (HALF * 2) * sc;
    c.translate(S / 2, S / 2);
    c.scale(-1, -1);
    c.drawImage(tex, -full / 2, -full / 2, full, full);
    c.restore();
  }
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.strokeRect(...toM(PLAY, PLAY), PLAY * 2 * sc, PLAY * 2 * sc);
  // buildings
  c.fillStyle = 'rgba(30,26,22,0.6)';
  for (const b of g.world.map.buildings) {
    if (b.destroyed || b.type === 'rock') continue;
    const [x, y] = toM(b.x, b.z);
    c.fillRect(x - (b.w * sc) / 2, y - (b.d * sc) / 2, Math.max(1, b.w * sc), Math.max(1, b.d * sc));
  }
  // capture points
  g.points.forEach((p, i) => {
    const [x, y] = toM(p.x, p.z);
    c.beginPath(); c.arc(x, y, p.r * sc, 0, Math.PI * 2);
    c.fillStyle = p.owner === 0 ? 'rgba(90,169,255,0.35)' : p.owner === 1 ? 'rgba(255,90,74,0.35)' : 'rgba(220,220,220,0.25)';
    c.fill();
    c.fillStyle = '#fff'; c.font = '800 11px ui-sans-serif, system-ui'; c.textAlign = 'center';
    c.fillText(String.fromCharCode(65 + i), x, y + 4);
  });
  const me = g.me;
  for (const v of g.vehicles.values()) {
    if (!v.root.visible || !v.alive) continue;
    const ally = me ? v.team === me.team : true;
    if (!ally && !g.mySpotted.has(v.id)) continue;
    const [x, y] = toM(v.pos.x, v.pos.z);
    const f = v.forward();
    c.save();
    c.translate(x, y); c.rotate(Math.atan2(-f.x, f.z));
    c.fillStyle = v === me ? '#ffe14a' : TEAM_COL[v.team];
    c.beginPath();
    if (v.kind === 'aircraft') { c.moveTo(0, -6); c.lineTo(5, 4); c.lineTo(0, 2); c.lineTo(-5, 4); }
    else { c.moveTo(0, -5); c.lineTo(4, 4); c.lineTo(-4, 4); }
    c.closePath(); c.fill();
    c.restore();
  }
  // view cone
  if (me) {
    const [x, y] = toM(me.pos.x, me.pos.z);
    const d = g.camera.getWorldDirection(new THREE.Vector3());
    const a = Math.atan2(-d.z, -d.x);
    c.fillStyle = 'rgba(255,240,160,0.12)';
    c.beginPath(); c.moveTo(x, y);
    c.arc(x, y, 60, a - 0.5, a + 0.5);
    c.closePath(); c.fill();
  }
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.strokeRect(0.5, 0.5, S - 1, S - 1);
}
