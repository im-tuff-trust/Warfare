import * as THREE from 'three';
import { AMMO, type AmmoSpec } from './data/ammo';
import { getVehicle, type AircraftSpec, type TankSpec } from './data/vehicles';
import { audio } from './audio';
import { Aircraft, Tank, type GameCtx, type Team, type Vehicle } from './entities';
import { PlaneBrain, TankBrain, TeamBrain, predictBombImpact, type AIContext } from './ai';
import { Effects } from './render/effects';
import { World } from './world/world';
import { Input } from './input';
import { HudStore, type KillFeedItem, type Notice, type ScoreRow } from './hud';
import { allowedVehicles, type RosterEntry, type Session, type StartInfo } from './net/session';
import { crewStatusLabel, intersectTank, previewShot, resolveBlast, resolveShot, roleStatus, type HitReport } from './sim/damage';
import { getLayout } from './sim/layout';
import { ROLE_NAMES } from './data/vehicles';
import { drawMinimap, drawOverlay } from './render/overlay';

export type Quality = 'low' | 'medium' | 'high';
export interface GameOptions { quality: Quality; sensitivity: number; volume: number; }

interface Proj {
  shooter: Vehicle; team: Team; ammo: AmmoSpec; pos: THREE.Vector3; vel: THREE.Vector3; life: number; traveled: number;
  auth: boolean; visual: boolean; mesh?: THREE.Object3D; trailAcc: number; color: THREE.Color; dead: boolean;
}

interface PointState { name: string; x: number; z: number; r: number; owner: number; progress: number; contested: boolean; }

export interface HitMarker { time: number; result: string; text: string; }
export interface DamageIndicator { time: number; from: THREE.Vector3; pen: boolean; }

const TICK_SNAP = 1 / 12;
const UP = new THREE.Vector3(0, 1, 0);

export class Game implements GameCtx, AIContext {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  world: World;
  effects: Effects;
  input: Input;
  hud: HudStore;
  vehicles = new Map<string, Vehicle>();
  roster: RosterEntry[];
  time = 0;
  myId: string;
  camPos = new THREE.Vector3();
  shadows: boolean;
  rules: { medkits: boolean; crewReplacement: boolean };
  points: PointState[] = [];
  tickets: [number, number];
  stats = new Map<string, { k: number; d: number; s: number; caps: number }>();
  killfeed: KillFeedItem[] = [];
  notices: Notice[] = [];
  incoming: HitReport[] = [];
  outgoing: HitReport | null = null;
  outgoingTime = 0;
  hitMarkers: HitMarker[] = [];
  damageIndicators: DamageIndicator[] = [];
  spotted: [Set<string>, Set<string>] = [new Set(), new Set()];
  mySpotted = new Set<string>();
  view: 'third' | 'gunner' | 'driver' | 'chase' | 'cockpit' = 'third';
  camYaw = 0; camPitch = -0.12; camDist = 11; zoom = 1;
  aimPoint = new THREE.Vector3();
  gunPoint: THREE.Vector3 | null = null;
  penPreview: { verdict: string; effective: number; pen: number; section: string } | null = null;
  bombImpact: THREE.Vector3 | null = null;
  ended = false;
  winner = -1;
  endReason = '';
  timeLeft: number;
  overlay: HTMLCanvasElement;
  minimap: HTMLCanvasElement | null = null;
  private octx: CanvasRenderingContext2D;
  private projs: Proj[] = [];
  private tracerMesh: THREE.InstancedMesh;
  private bombGeo = new THREE.CapsuleGeometry(0.18, 1.0, 4, 8);
  private bombMat = new THREE.MeshLambertMaterial({ color: 0x3a3d36 });
  private raf = 0;
  private last = 0;
  private snapAcc = 0;
  private dsAcc = 0;
  private spotAcc = 0;
  private hudAcc = 0;
  private hostAcc = 0;
  private miniAcc = 0;
  private brains = new Map<string, TankBrain | PlaneBrain>();
  teamBrain = new TeamBrain();
  private noticeId = 0;
  private killId = 0;
  private fpsAcc = 0; private fpsN = 0; private fps = 60;
  private respawnAt = 0;
  private respawnChoice = '';
  private botRespawn = new Map<string, number>();
  private sun: THREE.DirectionalLight;
  private sky: THREE.Mesh;
  private disposed = false;
  private lastAlarm = 0;
  private settings: StartInfo['settings'];
  private startedAt: number;
  private cockpitOn = false;
  onExit: (() => void) | null = null;
  private resizeObs: ResizeObserver;

  constructor(private container: HTMLElement, public session: Session, info: StartInfo, hud: HudStore, private opts: GameOptions) {
    this.hud = hud;
    this.myId = session.myId;
    this.settings = info.settings;
    this.roster = info.roster.slice();
    this.rules = { medkits: info.settings.medkits, crewReplacement: info.settings.crewReplacement };
    this.tickets = [info.settings.tickets, info.settings.tickets];
    this.timeLeft = info.settings.timeLimit * 60;
    this.startedAt = info.startedAt;
    this.shadows = opts.quality !== 'low';

    // ---------------- renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: opts.quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.quality === 'high' ? 1.75 : opts.quality === 'medium' ? 1.25 : 1));
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.overlay = document.createElement('canvas');
    Object.assign(this.overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', width: '100%', height: '100%' });
    container.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
    this.input = new Input(this.renderer.domElement);
    this.input.sensitivity = opts.sensitivity;

    // ---------------- world & lighting
    this.world = new World(info.settings.map, info.seed, opts.quality);
    const th = this.world.map.def.theme;
    this.scene.background = new THREE.Color(th.horizon);
    this.scene.fog = new THREE.Fog(th.fog, th.fogNear, th.fogFar * (opts.quality === 'low' ? 0.75 : 1));
    this.scene.add(new THREE.HemisphereLight(th.sky, th.ground[0], th.ambient * 1.35));
    this.sun = new THREE.DirectionalLight(th.sun, th.sunIntensity);
    const sd = new THREE.Vector3(...th.sunDir).normalize();
    this.sun.position.copy(sd).multiplyScalar(300);
    if (this.shadows) {
      this.sun.castShadow = true;
      const S = opts.quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(S, S);
      const c = this.sun.shadow.camera;
      c.left = -110; c.right = 110; c.top = 110; c.bottom = -110; c.near = 10; c.far = 800;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.6;
    }
    this.scene.add(this.sun, this.sun.target);
    this.sky = this.makeSky(th.sky, th.horizon, sd);
    this.scene.add(this.sky);
    this.world.build(this.scene);
    this.effects = new Effects(this.scene, opts.quality);
    this.effects.heightAt = (x, z) => this.world.height(x, z);
    this.points = this.world.map.points.map((p) => ({ name: p.name, x: p.x, z: p.z, r: p.r, owner: -1, progress: 0, contested: false }));

    // tracer pool
    const tg = new THREE.BoxGeometry(1, 1, 1);
    this.tracerMesh = new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), 700);
    this.tracerMesh.count = 0;
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.scene.add(this.tracerMesh);

    // ---------------- vehicles
    for (const r of this.roster) this.createVehicle(r);
    const me = this.vehicles.get(this.myId);
    if (me) this.respawnLocal(me, true);
    if (this.session.isHost) this.adoptBots(true);
    session.gameHandler = (from, msg) => this.onNet(from, msg);
    session.hostChangeHandler = (h) => this.onHostChange(h);
    session.peersHandler = (peers) => this.onPeers(peers.map((p) => p.id));

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    audio.init();
    audio.setVolume(opts.volume);
    audio.startAmbient(this.world.map.def.id === 'africa' || this.world.map.def.id === 'kursk');
    this.hud.set({ phase: 'playing', roomCode: session.code, mode: session.mode, isHost: session.isHost, maxTickets: info.settings.tickets });
    this.notice(`${this.world.map.def.location} — ${this.world.map.def.date}. Capture and hold the objectives!`, 'info');
    (window as unknown as { __warfare?: Game }).__warfare = this; // debugging / automated tests
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ============================================================ setup helpers

  private makeSky(top: number, horizon: number, sunDir: THREE.Vector3): THREE.Mesh {
    const g = new THREE.SphereGeometry(3000, 24, 12);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(top) }, hor: { value: new THREE.Color(horizon) }, sun: { value: sunDir } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vD; uniform vec3 top; uniform vec3 hor; uniform vec3 sun;
        void main(){ float h = clamp(vD.y*1.6, 0.0, 1.0); vec3 c = mix(hor, top, pow(h, 0.6));
          float s = max(0.0, dot(normalize(vD), normalize(sun))); c += vec3(1.0,0.9,0.7) * (pow(s, 600.0)*2.0 + pow(s, 12.0)*0.15);
          if (vD.y < 0.0) c = hor; gl_FragColor = vec4(c, 1.0); }`,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    return mesh;
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.overlay.width = w * dpr; this.overlay.height = h * dpr;
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.effects.scale.value = (h * this.renderer.getPixelRatio()) / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  ownerOf(v: { isBot: boolean; id: string }) { return v.isBot ? this.session.hostId : v.id; }
  get me(): Vehicle | undefined { return this.vehicles.get(this.myId); }
  get myTeam(): Team { return (this.roster.find((r) => r.id === this.myId)?.team ?? 0) as Team; }

  private createVehicle(r: RosterEntry, vehicleId = r.vehicleId): Vehicle {
    const old = this.vehicles.get(r.id);
    if (old) { old.dispose(this); this.brains.delete(r.id); }
    const spec = getVehicle(vehicleId);
    const owner = this.ownerOf(r);
    const v = spec.kind === 'tank'
      ? new Tank(r.id, r.name, r.team, r.isBot, owner, spec as TankSpec, this)
      : new Aircraft(r.id, r.name, r.team, r.isBot, owner, spec as AircraftSpec, this);
    v.local = owner === this.myId;
    v.alive = false;
    v.root.visible = false;
    this.vehicles.set(r.id, v);
    if (!this.stats.has(r.id)) this.stats.set(r.id, { k: 0, d: 0, s: 0, caps: 0 });
    if (v.local && r.isBot) this.makeBrain(v);
    return v;
  }

  private makeBrain(v: Vehicle) {
    const d = this.settings.difficulty;
    this.brains.set(v.id, v.kind === 'tank' ? new TankBrain(v as Tank, d, this.teamBrain) : new PlaneBrain(v as Aircraft, d, this.teamBrain));
  }

  spawnZone(team: Team): THREE.Vector3 {
    const s = this.world.map.spawns[team][0];
    return new THREE.Vector3(0, 0, s.z);
  }

  /** Spawn (or respawn) a vehicle this client owns. */
  private respawnLocal(v: Vehicle, first = false, vehicleId?: string) {
    let veh = v;
    const r = this.roster.find((x) => x.id === v.id);
    if (!r) return;
    if (vehicleId && vehicleId !== v.spec.id) {
      r.vehicleId = vehicleId;
      veh = this.createVehicle(r, vehicleId);
    }
    const team = veh.team;
    const spawns = this.world.map.spawns[team];
    if (veh.kind === 'tank') {
      // pick a spawn slot not occupied by another tank
      let best = spawns[0], bd = -1;
      for (const s of spawns) {
        let md = 1e9;
        for (const o of this.vehicles.values()) if (o !== veh && o.alive && o.kind === 'tank') md = Math.min(md, Math.hypot(o.pos.x - s.x, o.pos.z - s.z));
        const score = md + Math.random() * 5;
        if (score > bd) { bd = score; best = s; }
      }
      (veh as Tank).spawn(best.x, best.z, best.yaw, this);
      (veh as Tank).dmg.medkits = this.rules.medkits ? 1 : 0;
    } else {
      const s = spawns[Math.floor(Math.random() * spawns.length)];
      const x = s.x * 3 + (Math.random() - 0.5) * 120, z = s.z * 1.25;
      (veh as Aircraft).spawn(x, this.world.height(x, z) + 380 + Math.random() * 80, z, s.yaw, this);
    }
    veh.root.visible = true;
    this.send({ t: 'spawn', id: veh.id, vid: veh.spec.id, x: veh.pos.x, y: veh.pos.y, z: veh.pos.z, q: veh.quat.toArray() });
    if (veh.id === this.myId) {
      this.view = veh.kind === 'tank' ? 'third' : 'chase';
      this.camYaw = veh.kind === 'tank' ? (veh as Tank).yaw : Math.atan2(veh.forward().x, veh.forward().z);
      this.camPitch = -0.12; this.zoom = 1;
      this.cockpitOn = false;
      this.hud.set({ phase: 'playing', myVehicleId: veh.spec.id, kind: veh.kind });
      if (!first) this.notice(`Deployed: ${veh.spec.name}`, 'info');
    }
  }

  /** Become the simulation owner of all AI vehicles (host). */
  private adoptBots(initial: boolean) {
    let delay = 0;
    for (const r of this.roster) {
      if (!r.isBot) continue;
      const v = this.vehicles.get(r.id);
      if (!v) continue;
      v.owner = this.myId;
      v.local = true;
      if (!this.brains.has(v.id)) this.makeBrain(v);
      if (initial || !v.alive) this.botRespawn.set(v.id, this.time + (initial ? 0.5 + delay : 3));
      delay += 0.15;
    }
  }

  // ============================================================ GameCtx API

  send(msg: unknown, to?: string) { this.session.send(msg, to); }

  fireProjectile(shooter: Vehicle, ammo: AmmoSpec, pos: THREE.Vector3, vel: THREE.Vector3, visualOnly = false) {
    const auth = !visualOnly && shooter.local;
    const p: Proj = { shooter, team: shooter.team, ammo, pos: pos.clone(), vel: vel.clone(), life: ammo.kind === 'BOMB' ? 40 : ammo.kind === 'MG' ? 2.5 : 6, traveled: 0, auth, visual: true, trailAcc: 0, color: new THREE.Color(ammo.tracer || 0xffaa55), dead: false };
    if (ammo.kind === 'BOMB') {
      const m = new THREE.Mesh(this.bombGeo, this.bombMat);
      m.scale.setScalar(Math.max(0.6, ammo.caliber / 350));
      m.position.copy(pos);
      this.scene.add(m);
      p.mesh = m;
    }
    this.projs.push(p);
    if (ammo.kind !== 'MG') {
      const dir = vel.clone().normalize();
      if (ammo.kind !== 'BOMB' && ammo.kind !== 'ROCKET') {
        this.effects.muzzleFlash(pos, dir, ammo.caliber, shooter.kind === 'tank');
        audio.cannon(pos, ammo.caliber);
      }
      if (auth && shooter.kind === 'tank') this.send({ t: 'fire', id: shooter.id, a: ammo.id, o: r3(pos), v: r3(vel) });
      if (auth && shooter.kind === 'aircraft') this.send({ t: 'fire', id: shooter.id, a: ammo.id, o: r3(pos), v: r3(vel) });
    } else if (shooter.local && !visualOnly) {
      if (Math.random() < 0.3) this.effects.muzzleFlash(pos, vel.clone().normalize(), ammo.caliber, false);
    }
  }

  onBuildingRam(idx: number, dmg: number) {
    this.applyBuildingDamage(idx, dmg, true);
  }

  onTreeKnock(idx: number, dir: number) {
    const t = this.world.map.trees[idx];
    if (!t || t.fallen) return;
    this.world.knockTree(idx, dir);
    this.send({ t: 'tree', i: idx, d: Math.round(dir * 100) / 100 });
  }

  private applyBuildingDamage(idx: number, dmg: number, broadcast: boolean) {
    const b = this.world.map.buildings[idx];
    if (!b || b.destroyed || b.indestructible) return;
    if (broadcast) this.send({ t: 'bdmg', i: idx, d: Math.round(dmg) });
    if (this.world.damageBuilding(idx, dmg)) {
      this.world.destroyBuilding(idx);
      const p = new THREE.Vector3(b.x, b.y + b.h * 0.4, b.z);
      if (!b.instanced) {
        this.effects.explosion(p, Math.min(4, 1 + Math.max(b.w, b.d) / 8), 'building');
        audio.explosion(p, 1.5);
      } else this.effects.impact(p, UP, 'building', 1, this.world.map.def.theme.dust);
    }
  }

  onLocalDestroyed(v: Vehicle, cause: string) {
    if (!v.alive && !(v.kind === 'aircraft' && cause === 'crashed')) return;
    const wasAlive = v.alive;
    const killer = v.lastAttacker && this.time - v.lastAttackerTime < 30 ? v.lastAttacker : '';
    const det = cause === 'ammo detonation' || (v.kind === 'tank' && (v as Tank).dmg.detonated);
    if (v.kind === 'tank') (v as Tank).onDestroyed(this, det);
    else (v as Aircraft).onDestroyed(this);
    if (!wasAlive) return;
    const msg = { t: 'kill', victim: v.id, killer, how: det ? 'ammo detonation' : cause };
    this.send(msg);
    this.handleKill(msg);
  }

  // ============================================================ AIContext API

  isSpotted(team: Team, v: Vehicle): boolean { return this.spotted[team].has(v.id); }

  // ============================================================ networking

  private onNet(from: string, msg: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (this.disposed) return;
    switch (msg.t) {
      case 'st': {
        for (const e of msg.e as (number | string)[][]) {
          const id = e[0] as string;
          let v = this.vehicles.get(id);
          const vid = e[12] as string;
          if (!v) {
            const r = this.roster.find((x) => x.id === id);
            if (!r) continue;
            v = this.createVehicle(r, vid);
          }
          if (v.local) continue;
          if (vid && v.spec.id !== vid) {
            const r = this.roster.find((x) => x.id === id)!;
            r.vehicleId = vid;
            v = this.createVehicle(r, vid);
          }
          if (!v.root.visible && ((e[11] as number) & 1)) { v.root.visible = true; v.alive = true; }
          v.applySnapshot(e, this.time);
        }
        break;
      }
      case 'spawn': {
        const r = this.roster.find((x) => x.id === msg.id);
        if (!r) break;
        let v = this.vehicles.get(msg.id);
        if (!v || v.spec.id !== msg.vid) { r.vehicleId = msg.vid; v = this.createVehicle(r, msg.vid); }
        if (v.local) break;
        if (v.kind === 'tank') {
          const q = new THREE.Quaternion().fromArray(msg.q);
          const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
          (v as Tank).spawn(msg.x, msg.z, e.y, this);
        } else {
          const q = new THREE.Quaternion().fromArray(msg.q);
          (v as Aircraft).spawn(msg.x, msg.y, msg.z, new THREE.Euler().setFromQuaternion(q, 'YXZ').y, this);
        }
        v.root.visible = true;
        v.buf = [];
        break;
      }
      case 'fire': {
        const v = this.vehicles.get(msg.id);
        if (!v || v.local) break;
        v.lastShot = this.time;
        this.fireProjectile(v, AMMO[msg.a], new THREE.Vector3(...(msg.o as [number, number, number])), new THREE.Vector3(...(msg.v as [number, number, number])), true);
        if (v.kind === 'tank') (v as Tank).recoil = 1;
        break;
      }
      case 'hit': {
        const v = this.vehicles.get(msg.target);
        if (!v || !v.local || v.kind !== 'tank') break;
        const shooter = this.vehicles.get(msg.shooter);
        this.resolveTankHit(v as Tank, shooter ?? null, msg.shooter, AMMO[msg.a], new THREE.Vector3(...(msg.o as [number, number, number])), new THREE.Vector3(...(msg.d as [number, number, number])), msg.dist, msg.ty, msg.gp);
        break;
      }
      case 'blast': {
        const v = this.vehicles.get(msg.target);
        if (!v || !v.local || v.kind !== 'tank') break;
        this.resolveTankBlast(v as Tank, msg.shooter, AMMO[msg.a], new THREE.Vector3(...(msg.c as [number, number, number])));
        break;
      }
      case 'ahit': {
        const v = this.vehicles.get(msg.target);
        if (!v || !v.local || v.kind !== 'aircraft') break;
        this.applyAircraftHit(v as Aircraft, msg.shooter, msg.dmg, msg.part, msg.fire);
        break;
      }
      case 'dmg': this.onDamageReport(msg.rep as HitReport, msg.crew, msg.structure, false); break;
      case 'ds': {
        const v = this.vehicles.get(msg.id);
        if (v && !v.local && v.kind === 'tank') {
          const t = v as Tank;
          if (msg.c.length === t.dmg.crew.length) t.dmg.crew = msg.c;
          if (msg.m.length === t.dmg.modules.length) t.dmg.modules = msg.m;
          t.dmg.structure = msg.s;
        }
        break;
      }
      case 'kill': this.handleKill(msg); break;
      case 'bdmg': this.applyBuildingDamage(msg.i, msg.d, false); break;
      case 'tree': this.world.knockTree(msg.i, msg.d); break;
      case 'score': if (!this.session.isHost) this.applyScore(msg); break;
      case 'end': this.endMatch(msg.winner, msg.reason); break;
      case 'order': if (this.session.isHost) this.applyOrder(msg); break;
      case 'notice': this.notice(msg.text, msg.kind ?? 'info'); break;
      case 'rosterAdd': {
        if (!this.roster.find((r) => r.id === msg.entry.id)) { this.roster.push(msg.entry); this.createVehicle(msg.entry); }
        this.notice(`${msg.entry.name} joined the battle`, 'info');
        break;
      }
      case 'removeBot': {
        const v = this.vehicles.get(msg.id);
        if (v) { v.dispose(this); this.vehicles.delete(msg.id); this.brains.delete(msg.id); }
        this.roster = this.roster.filter((r) => r.id !== msg.id);
        break;
      }
    }
    void from;
  }

  private onHostChange(host: string) {
    // re-assign AI ownership
    for (const v of this.vehicles.values()) {
      if (!v.isBot) continue;
      v.owner = host;
      v.local = host === this.myId;
      if (!v.local) this.brains.delete(v.id);
    }
    this.hud.set({ isHost: host === this.myId });
    if (host === this.myId) {
      this.adoptBots(false);
      this.notice('You are now the host: AI vehicles are simulated on this machine.', 'warn');
    }
  }

  private onPeers(ids: string[]) {
    const set = new Set(ids);
    for (const v of [...this.vehicles.values()]) {
      if (v.isBot || v.id === this.myId) continue;
      if (!set.has(v.id)) {
        this.notice(`${v.name} left the battle`, 'warn');
        v.dispose(this);
        this.vehicles.delete(v.id);
        this.roster = this.roster.filter((r) => r.id !== v.id);
      }
    }
  }

  // ============================================================ damage resolution

  private resolveTankHit(t: Tank, shooter: Vehicle | null, shooterId: string, ammo: AmmoSpec, o: THREE.Vector3, d: THREE.Vector3, dist: number, ty: number, gp: number) {
    if (!t.alive) return;
    const rep = resolveShot(t.tspec, t.dmg, {
      o, d, ammo, dist, turretYaw: ty ?? t.turretYaw, gunPitch: gp ?? t.gunPitch, time: this.time,
      shooter: shooterId, shooterName: shooter?.name ?? '?', target: t.id, targetName: t.name,
    });
    if (!rep) return;
    if (rep.result !== 'ricochet' && rep.result !== 'nonpen') { t.lastAttacker = shooterId; t.lastAttackerTime = this.time; }
    else if (!t.lastAttacker || this.time - t.lastAttackerTime > 10) { t.lastAttacker = shooterId; t.lastAttackerTime = this.time; }
    this.publishReport(t, rep);
  }

  private resolveTankBlast(t: Tank, shooterId: string, ammo: AmmoSpec, cLocal: THREE.Vector3) {
    if (!t.alive) return;
    const sh = this.vehicles.get(shooterId);
    const rep = resolveBlast(t.tspec, t.dmg, cLocal, ammo, this.time, shooterId, sh?.name ?? '?', t.id, t.name, t.turretYaw);
    if (!rep) return;
    t.lastAttacker = shooterId; t.lastAttackerTime = this.time;
    this.publishReport(t, rep);
  }

  private publishReport(t: Tank, rep: HitReport) {
    this.send({ t: 'dmg', rep, crew: t.dmg.crew, structure: t.dmg.structure });
    this.onDamageReport(rep, t.dmg.crew, t.dmg.structure, true);
    if (rep.destroyed && t.alive) this.onLocalDestroyed(t, rep.ammoDetonation ? 'ammo detonation' : 'destroyed');
  }

  /** Visualize and log a hit report (from any source). */
  private onDamageReport(rep: HitReport, crew: number[], structure: number, local: boolean) {
    const t = this.vehicles.get(rep.target) as Tank | undefined;
    if (!t || t.kind !== 'tank') return;
    if (!local) { if (crew?.length === t.dmg.crew.length) t.dmg.crew = crew; t.dmg.structure = structure; }
    // world-space impact point
    const lp = new THREE.Vector3(...rep.point);
    const wp = t.localToWorld(lp, new THREE.Vector3());
    const dir = t.dirToLocal(new THREE.Vector3(...rep.dir)).negate();
    void dir;
    const n = new THREE.Vector3(...rep.dir).negate();
    const kind = rep.result === 'ricochet' ? 'ricochet' : rep.result === 'pen' || rep.result === 'partial' ? 'pen' : 'nonpen';
    if (rep.result !== 'blast') {
      this.effects.impact(wp, n, kind);
      if (rep.result === 'ricochet') audio.ricochet(wp); else audio.armorHit(wp, rep.result === 'pen');
    }
    if (rep.fire) this.effects.flash(wp, 6, 0.3);
    // my vehicle hit: record incoming report
    if (rep.target === this.myId) {
      this.incoming.unshift(rep);
      if (this.incoming.length > 25) this.incoming.pop();
      const sh = this.vehicles.get(rep.shooter);
      if (sh) this.damageIndicators.push({ time: this.time, from: sh.pos.clone(), pen: rep.result === 'pen' || rep.result === 'partial' || rep.result === 'blast' });
      audio.interiorHit(rep.result === 'pen' || rep.result === 'blast');
      const text = `${rep.summary} — ${rep.section}`;
      this.notice(text, rep.result === 'ricochet' || rep.result === 'nonpen' ? 'good' : 'bad');
      if (rep.fire) { this.notice('FIRE! Press F to extinguish', 'bad'); audio.alarm(); }
      for (const c of rep.crewHit) {
        const roles = c.roles.map((r) => ROLE_NAMES[r]).join('/');
        this.notice(`${roles}: ${c.status}${c.hpAfter <= 0 ? '' : ` (${c.hpAfter}%)`}`, c.hpAfter <= 0 ? 'bad' : 'warn');
      }
      this.pushHud(true);
    }
    // my shot: hit camera
    if (rep.shooter === this.myId) {
      this.outgoing = rep;
      this.outgoingTime = this.time;
      this.hitMarkers.push({ time: this.time, result: rep.result, text: rep.result === 'ricochet' ? 'RICOCHET' : rep.result === 'nonpen' ? 'NO PENETRATION' : rep.result === 'partial' ? 'PARTIAL PEN' : rep.result === 'pen' ? 'PENETRATION' : rep.result === 'module' ? 'COMPONENT HIT' : 'HIT' });
      this.pushHud(true);
    }
  }

  private applyAircraftHit(a: Aircraft, shooterId: string, dmg: number, part: string, fire: number) {
    if (!a.alive) return;
    a.lastAttacker = shooterId; a.lastAttackerTime = this.time;
    a.applyDamage(dmg, part, fire);
    if (a.id === this.myId && Math.random() < 0.3) audio.armorHit(undefined, false);
    if (a.hp <= 0 || a.pilot <= 0) this.onLocalDestroyed(a, a.pilot <= 0 ? 'pilot killed' : 'shot down');
  }

  private handleKill(msg: { victim: string; killer: string; how: string }) {
    const v = this.vehicles.get(msg.victim);
    if (v && !v.local) {
      if (v.kind === 'tank') (v as Tank).onDestroyed(this, msg.how === 'ammo detonation');
      else (v as Aircraft).onDestroyed(this);
    }
    if (v) {
      const p = v.kind === 'tank' ? v.pos.clone().setY(v.pos.y + 1.5) : v.pos.clone();
      const big = msg.how === 'ammo detonation';
      if (v.kind === 'tank' || msg.how !== 'crashed') {
        this.effects.explosion(p, big ? 4.5 : 2.2, big ? 'ammo' : 'he', this.world.map.def.theme.dust);
        audio.explosion(p, big ? 4 : 2);
        if (v.kind === 'tank') this.world.scorch(v.pos.x, v.pos.z, big ? 9 : 6);
      }
    }
    const killer = this.vehicles.get(msg.killer);
    const kt = killer?.team ?? -1, vt = v?.team ?? -1;
    this.killfeed.unshift({ id: this.killId++, killer: killer?.name ?? '', victim: v?.name ?? '?', kt, vt, how: msg.how, time: this.time, mine: msg.killer === this.myId || msg.victim === this.myId });
    if (this.killfeed.length > 6) this.killfeed.pop();
    if (msg.killer === this.myId && v) this.notice(`Destroyed ${v.name} (${v.spec.name})`, 'good');
    if (msg.victim === this.myId) {
      this.respawnAt = this.time + 6;
      this.hud.set({ phase: 'dead', killedBy: killer ? `${killer.name} (${killer.spec.name})` : msg.how });
    }
    if (this.session.isHost) {
      const sv = this.stats.get(msg.victim); if (sv) sv.d++;
      const sk = this.stats.get(msg.killer);
      if (sk && killer && v && killer.team !== v.team) { sk.k++; sk.s += 100; }
      if (v && v.team !== undefined) this.tickets[v.team] = Math.max(0, this.tickets[v.team] - 4);
      if (v?.isBot) this.botRespawn.set(v.id, this.time + 8);
    }
    this.pushHud(true);
  }

  // ============================================================ projectiles

  private updateProjectiles(dt: number) {
    const seg = new THREE.Vector3(), dir = new THREE.Vector3();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    let ti = 0;
    for (const p of this.projs) {
      if (p.dead) continue;
      p.life -= dt;
      if (p.life <= 0) { p.dead = true; continue; }
      const a = p.ammo;
      const g = a.kind === 'ROCKET' ? 3 : 9.81;
      p.vel.y -= g * dt;
      p.vel.multiplyScalar(1 - a.drag * dt);
      seg.copy(p.vel).multiplyScalar(dt);
      const L = seg.length();
      dir.copy(seg).divideScalar(L);
      const hit = this.traceProjectile(p, dir, L);
      if (hit) { p.dead = true; this.onProjectileHit(p, hit, dir); continue; }
      p.pos.add(seg);
      p.traveled += L;
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
        p.mesh.quaternion.setFromUnitVectors(UP, dir);
      }
      if (a.kind === 'ROCKET') {
        p.trailAcc += dt;
        if (p.trailAcc > 0.02) { p.trailAcc = 0; this.effects.trail(p.pos, false); this.effects.fire.spawn({ x: p.pos.x, y: p.pos.y, z: p.pos.z, max: 0.08, s0: 0.9, s1: 0.3, r: 1, g: 0.7, b: 0.3, a: 1 }); }
      }
      if (a.kind !== 'BOMB' && ti < 700) {
        const speed = p.vel.length();
        const len = Math.min(speed * 0.022, a.kind === 'MG' ? 9 : 16);
        const w = a.kind === 'MG' ? 0.06 + a.caliber / 400 : 0.08 + a.caliber / 800;
        q.setFromUnitVectors(Z, dir);
        s.set(w, w, len);
        m.compose(p.pos.clone().addScaledVector(dir, -len / 2), q, s);
        this.tracerMesh.setMatrixAt(ti, m);
        this.tracerMesh.setColorAt(ti, p.color);
        ti++;
      }
    }
    this.tracerMesh.count = ti;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
    for (const p of this.projs) if (p.dead && p.mesh) { this.scene.remove(p.mesh); p.mesh = undefined; }
    this.projs = this.projs.filter((p) => !p.dead);
  }

  private traceProjectile(p: Proj, dir: THREE.Vector3, L: number): { t: number; kind: 'tank' | 'air' | 'world'; v?: Vehicle; worldHit?: ReturnType<World['raycast']>; lo?: THREE.Vector3; ld?: THREE.Vector3 } | null {
    let best: { t: number; kind: 'tank' | 'air' | 'world'; v?: Vehicle; worldHit?: ReturnType<World['raycast']>; lo?: THREE.Vector3; ld?: THREE.Vector3 } | null = null;
    const o = p.pos;
    for (const v of this.vehicles.values()) {
      if (v === p.shooter || !v.root.visible) continue;
      if (v.kind === 'tank') {
        const t = v as Tank;
        const c = t.center;
        const R = t.tspec.hull.L * 0.75 + 1;
        // segment-sphere broad phase
        const tc = Math.max(0, Math.min(L, c.clone().sub(o).dot(dir)));
        const closest = o.clone().addScaledVector(dir, tc);
        if (closest.distanceToSquared(c) > R * R) continue;
        const lo = t.worldToLocal(o);
        const ld = t.dirToLocal(dir);
        const h = intersectTank(t.tspec, lo, ld, t.turretYaw, t.gunPitch, L);
        if (h && (!best || h.t < best.t)) best = { t: h.t, kind: 'tank', v, lo, ld };
      } else {
        if (!v.alive && (v as Aircraft).crashed) continue;
        const a = v as Aircraft;
        const R = a.aspec.cls === 'bomber' ? a.aspec.span * 0.32 : a.aspec.span * 0.3;
        const tc = Math.max(0, Math.min(L, v.pos.clone().sub(o).dot(dir)));
        const closest = o.clone().addScaledVector(dir, tc);
        if (closest.distanceToSquared(v.pos) < R * R && (!best || tc < best.t)) best = { t: tc, kind: 'air', v };
      }
    }
    const wh = this.world.raycast(o, dir, best ? best.t : L, false);
    if (wh && (!best || wh.t < best.t)) best = { t: wh.t, kind: 'world', worldHit: wh };
    return best;
  }

  private onProjectileHit(p: Proj, hit: NonNullable<ReturnType<Game['traceProjectile']>>, dir: THREE.Vector3) {
    const a = p.ammo;
    const at = p.pos.clone().addScaledVector(dir, hit.t);
    const dist = p.traveled + hit.t;
    const dustCol = this.world.map.def.theme.dust;
    if (hit.kind === 'tank') {
      const t = hit.v as Tank;
      if (!t.alive) { this.effects.impact(at, dir.clone().negate(), 'nonpen'); return; }
      if (!p.auth) return; // the owner's hit report will display the effect
      const lo = hit.lo!.clone(), ld = hit.ld!.clone();
      if (t.local) this.resolveTankHit(t, p.shooter, p.shooter.id, a, lo, ld, dist, t.turretYaw, t.gunPitch);
      else this.send({ t: 'hit', target: t.id, shooter: p.shooter.id, a: a.id, o: r3(lo), d: r3(ld, 1e4), dist: Math.round(dist), ty: t.turretYaw, gp: t.gunPitch }, this.ownerOf(t));
      if (a.kind === 'HE' || a.kind === 'BOMB' || a.kind === 'ROCKET') this.splash(p, at, t);
      // ricochet visual
      return;
    }
    if (hit.kind === 'air') {
      const v = hit.v as Aircraft;
      this.effects.impact(at, dir.clone().negate(), a.kind === 'MG' ? 'small' : 'nonpen');
      if (!p.auth) return;
      if (a.kind !== 'MG') this.effects.explosion(at, 0.8, 'small');
      const r = Math.random();
      const part = r < 0.25 ? 'engine' : r < 0.32 ? 'pilot' : r < 0.4 && v.aspec.gunner ? 'gunner' : r < 0.55 ? 'tail' : 'wing';
      const dmg = a.kind === 'MG' ? a.damage * (0.8 + Math.random() * 0.4) : a.damage * 2.5 + a.explosive * 40;
      const fire = a.kind === 'MG' ? 0.006 + a.explosive * 2 : 0.25;
      if (v.local) this.applyAircraftHit(v, p.shooter.id, dmg, part, fire);
      else this.send({ t: 'ahit', target: v.id, shooter: p.shooter.id, dmg: Math.round(dmg * 10) / 10, part, fire }, this.ownerOf(v));
      return;
    }
    const wh = hit.worldHit!;
    if (wh.kind === 'water') {
      this.effects.impact(at, UP, 'water', a.kind === 'BOMB' ? 3 : 1);
      if (a.kind === 'BOMB') audio.explosion(at, 1.5);
      return;
    }
    const explosive = a.kind === 'HE' || a.kind === 'BOMB' || a.kind === 'ROCKET' || (a.kind === 'APHE' && a.caliber < 30);
    if (explosive) {
      const size = a.kind === 'BOMB' ? 1.5 + Math.cbrt(a.explosive) * 1.4 : a.kind === 'ROCKET' ? 1.4 : 0.5 + a.explosive * 1.5;
      this.effects.explosion(at, size, 'he', dustCol);
      audio.explosion(at, size);
      if (a.kind === 'BOMB' || a.explosive > 0.5) this.world.scorch(at.x, at.z, size * 2);
    } else if (a.kind === 'MG') {
      if (Math.random() < 0.4) this.effects.impact(at, wh.normal, 'small', 1, dustCol);
    } else {
      this.effects.impact(at, wh.normal, wh.kind === 'building' ? 'building' : 'ground', Math.max(0.6, a.caliber / 70), dustCol);
      audio.ground(at);
    }
    if (!p.auth) return;
    if (wh.kind === 'building') {
      const dmg = a.kind === 'MG' ? a.damage * 0.5 : a.damage * 3 + a.explosive * 250;
      this.applyBuildingDamage(wh.idx, dmg, true);
    }
    if (explosive) this.splash(p, at, null);
  }

  /** HE/bomb splash damage to tanks and buildings around a point (authoritative shooter). */
  private splash(p: Proj, at: THREE.Vector3, direct: Tank | null) {
    const a = p.ammo;
    const R = a.kind === 'BOMB' ? 3.2 * Math.cbrt(a.explosive) + 6 : 3 + a.explosive * 4;
    for (const v of this.vehicles.values()) {
      if (!v.alive || v === direct || v.kind !== 'tank') continue;
      const t = v as Tank;
      if (t.pos.distanceTo(at) > R + t.tspec.hull.L / 2) continue;
      const lc = t.worldToLocal(at);
      if (t.local) this.resolveTankBlast(t, p.shooter.id, a, lc);
      else this.send({ t: 'blast', target: t.id, shooter: p.shooter.id, a: a.id, c: r3(lc) }, this.ownerOf(t));
    }
    if (a.kind === 'BOMB') {
      const bs = this.world.map.buildings;
      for (const b of bs) {
        if (b.destroyed || b.indestructible) continue;
        const d = Math.hypot(b.x - at.x, b.z - at.z) - Math.max(b.w, b.d) / 2;
        if (d < R * 0.6) this.applyBuildingDamage(b.idx, a.damage * 12 * (1 - Math.max(0, d) / (R * 0.6)), true);
      }
      for (const t of this.world.map.trees) {
        if (!t.fallen && Math.hypot(t.x - at.x, t.z - at.z) < R * 0.5) this.onTreeKnock(t.idx, Math.atan2(t.x - at.x, t.z - at.z));
      }
    }
  }

  // ============================================================ host rules

  private hostUpdate(dt: number) {
    // capture points
    for (let i = 0; i < this.points.length; i++) {
      const pt = this.points[i];
      let a = 0, b = 0;
      const inside: Vehicle[] = [];
      for (const v of this.vehicles.values()) {
        if (!v.alive || v.kind !== 'tank') continue;
        if (Math.hypot(v.pos.x - pt.x, v.pos.z - pt.z) < pt.r) { if (v.team === 0) a++; else b++; inside.push(v); }
      }
      pt.contested = a > 0 && b > 0;
      const rate = dt / 14;
      const prevOwner = pt.owner;
      if (a > 0 && b === 0) pt.progress = Math.min(1, pt.progress + rate * Math.min(3, a));
      else if (b > 0 && a === 0) pt.progress = Math.max(-1, pt.progress - rate * Math.min(3, b));
      if (pt.progress >= 1) pt.owner = 0;
      else if (pt.progress <= -1) pt.owner = 1;
      else if ((pt.owner === 0 && pt.progress <= 0) || (pt.owner === 1 && pt.progress >= 0)) pt.owner = -1;
      if (pt.owner !== prevOwner && pt.owner !== -1) {
        const team = pt.owner;
        for (const v of inside) if (v.team === team) { const st = this.stats.get(v.id); if (st) { st.caps++; st.s += 150; } }
        const msg = { t: 'notice', text: `${team === 0 ? 'Allies' : 'Axis'} captured ${String.fromCharCode(65 + i)} — ${pt.name}`, kind: 'info' };
        this.send(msg);
        this.notice(msg.text, team === this.myTeam ? 'good' : 'bad');
      }
    }
    // ticket bleed
    this.hostAcc += dt;
    if (this.hostAcc >= 2) {
      this.hostAcc -= 2;
      const own = [0, 0];
      for (const p of this.points) if (p.owner >= 0) own[p.owner]++;
      if (own[0] > own[1]) this.tickets[1] = Math.max(0, this.tickets[1] - (own[0] - own[1]));
      if (own[1] > own[0]) this.tickets[0] = Math.max(0, this.tickets[0] - (own[1] - own[0]));
      this.send({ t: 'score', tickets: this.tickets, points: this.points.map((p) => [Math.round(p.progress * 100) / 100, p.owner, p.contested ? 1 : 0]), stats: [...this.stats.entries()], timeLeft: this.timeLeft });
    }
    this.timeLeft -= dt;
    if (!this.ended) {
      let winner = -1, reason = '';
      if (this.tickets[0] <= 0) { winner = 1; reason = 'Allied tickets depleted'; }
      else if (this.tickets[1] <= 0) { winner = 0; reason = 'Axis tickets depleted'; }
      else if (this.timeLeft <= 0) { winner = this.tickets[0] === this.tickets[1] ? -1 : this.tickets[0] > this.tickets[1] ? 0 : 1; reason = 'Time limit reached'; }
      if (reason) {
        this.send({ t: 'score', tickets: this.tickets, points: this.points.map((p) => [p.progress, p.owner, 0]), stats: [...this.stats.entries()], timeLeft: 0 });
        this.send({ t: 'end', winner, reason });
        this.endMatch(winner, reason);
      }
    }
    // bot respawns
    for (const [id, at] of this.botRespawn) {
      if (this.time < at) continue;
      const v = this.vehicles.get(id);
      this.botRespawn.delete(id);
      if (!v || !v.local) continue;
      // aircraft quota: at most 2 per team in the air
      let vid = this.roster.find((r) => r.id === id)?.vehicleId;
      const spec = vid ? getVehicle(vid) : null;
      if (spec?.kind === 'aircraft') {
        const air = [...this.vehicles.values()].filter((o) => o.team === v.team && o.alive && o.kind === 'aircraft').length;
        if (air >= 2) vid = allowedVehicles(v.team, this.settings).find((x) => x.kind === 'tank' && x.cls === 'medium')?.id;
      }
      this.respawnLocal(v, false, vid);
      const nv = this.vehicles.get(id);
      if (nv && !this.brains.has(id)) this.makeBrain(nv);
    }
  }

  private applyScore(msg: { tickets: [number, number]; points: [number, number, number][]; stats: [string, { k: number; d: number; s: number; caps: number }][]; timeLeft: number }) {
    this.tickets = msg.tickets;
    msg.points.forEach((p, i) => { if (this.points[i]) { this.points[i].progress = p[0]; this.points[i].owner = p[1]; this.points[i].contested = !!p[2]; } });
    for (const [id, s] of msg.stats) this.stats.set(id, s);
    this.timeLeft = msg.timeLeft;
  }

  private applyOrder(msg: { team: Team; kind: 'attack' | 'follow' | 'defend'; targetId?: string; leaderId?: string; point?: number }) {
    this.teamBrain.setOrder(msg.team, { kind: msg.kind, until: this.time + 75, targetId: msg.targetId, leaderId: msg.leaderId, point: msg.point });
    // force AI to re-plan
    for (const b of this.brains.values()) if (b instanceof TankBrain && b.tank.team === msg.team) (b as unknown as { goalT: number }).goalT = 0;
  }

  private endMatch(winner: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = winner;
    this.endReason = reason;
    this.input.exitLock();
    this.pushHud(true);
    this.hud.set({ phase: 'ended', winner, endReason: reason });
  }

  // ============================================================ spotting

  private updateSpotting() {
    for (const team of [0, 1] as Team[]) {
      const set = new Set<string>();
      const allies = [...this.vehicles.values()].filter((v) => v.team === team && v.alive);
      for (const e of this.vehicles.values()) {
        if (e.team === team || !e.alive) continue;
        let seen = false;
        for (const a of allies) {
          const d = a.pos.distanceTo(e.pos);
          const isAirE = e.kind === 'aircraft', isAirA = a.kind === 'aircraft';
          let range = isAirE ? 1600 : isAirA ? 900 : 460;
          if (a.kind === 'tank') range *= (a as Tank).mods.spotting;
          if (this.time - e.lastShot < 4) range = Math.max(range, 850);
          if (d > range) continue;
          const eye = a.kind === 'tank' ? a.pos.clone().setY(a.pos.y + (a as Tank).tspec.hull.H + 0.9) : a.pos;
          const tgt = e.kind === 'tank' ? (e as Tank).center.clone() : e.pos;
          if (isAirE || isAirA) {
            if (!this.world.raycast(eye, tgt.clone().sub(eye).normalize(), d - 3, true)) { seen = true; break; }
          } else if (this.world.lineOfSight(eye, tgt)) { seen = true; break; }
        }
        if (seen) set.add(e.id);
      }
      this.spotted[team] = set;
    }
    // what *I* know depends on my commander (own spotting) and radio link to teammates
    const me = this.me;
    const mine = new Set<string>();
    if (me) {
      const radio = me.kind === 'tank' ? (me as Tank).mods.radio : 1;
      const linkRange = radio <= 0.05 ? 0 : 300 + 1500 * radio;
      for (const id of this.spotted[me.team]) {
        const e = this.vehicles.get(id)!;
        // directly visible to me?
        const myRange = (e.kind === 'aircraft' ? 1600 : 460) * (me.kind === 'tank' ? (me as Tank).mods.spotting : 1);
        if (me.alive && me.pos.distanceTo(e.pos) < myRange) { mine.add(id); continue; }
        // reported by a teammate in radio range
        for (const a of this.vehicles.values()) {
          if (a.team !== me.team || !a.alive || a === me) continue;
          if (a.pos.distanceTo(me.pos) < linkRange && a.pos.distanceTo(e.pos) < 1600) { mine.add(id); break; }
        }
        if (!me.alive) mine.add(id);
      }
    }
    this.mySpotted = mine;
  }

  // ============================================================ player control

  private playerControl(dt: number) {
    const me = this.me;
    const inp = this.input;
    if (inp.hit('Escape')) inp.exitLock();
    if (!me || !me.alive || this.ended) return;
    const sens = 0.0022;
    if (me.kind === 'tank') {
      const t = me as Tank;
      const zoomSens = this.view === 'gunner' ? 1 / Math.max(1, this.zoom) : 1;
      this.camYaw -= inp.mouseDX * sens * zoomSens;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch - inp.mouseDY * sens * zoomSens, -1.2, 0.6);
      if (inp.hit('KeyV')) this.view = this.view === 'driver' ? 'third' : this.view === 'third' ? 'driver' : 'third';
      if (inp.rmbPressed || inp.hit('ShiftLeft')) {
        this.view = this.view === 'gunner' ? 'third' : 'gunner';
        if (this.view === 'gunner') this.zoom = t.tspec.gun.zoom;
      }
      if (inp.wheel) {
        if (this.view === 'gunner') this.zoom = THREE.MathUtils.clamp(this.zoom - inp.wheel * 0.6, 1.5, t.tspec.gun.zoom * 1.6);
        else this.camDist = THREE.MathUtils.clamp(this.camDist + inp.wheel * 1.4, 6, 24);
      }
      t.input.throttle = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0);
      t.input.steer = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
      t.input.brake = inp.down('Space');
      t.input.fire = inp.lmb && inp.locked;
      if (this.view !== 'driver') t.input.aim = this.aimPoint.clone();
      for (let i = 0; i < 3; i++) if (inp.hit('Digit' + (i + 1))) { t.selectAmmo(i); audio.click(); }
      if (inp.hit('KeyR')) { if (t.startRepair()) this.notice('Crew repairing damaged components… stay stationary', 'info'); else this.notice('Nothing to repair', 'info'); }
      if (inp.hit('KeyF')) { if (t.extinguish()) this.notice('Extinguishing fire…', 'info'); else if (t.dmg.fire > 0) this.notice('No extinguishers left!', 'bad'); }
      if (inp.hit('KeyH')) {
        if (!this.rules.medkits) this.notice('Medkits are disabled by the match rules', 'warn');
        else if (t.useMedkit(this)) this.notice('First-aid kit used: wounded crew treated', 'good');
        else this.notice(t.dmg.medkits <= 0 ? 'No first-aid kits left (resupply at base)' : 'No wounded crew to treat', 'info');
      }
      this.issueOrders(t);
    } else {
      const a = me as Aircraft;
      // mouse rotates the aim direction (world-space)
      const yaw = -inp.mouseDX * sens * 0.9, pitch = -inp.mouseDY * sens * 0.9;
      const ad = a.aimDir;
      const right = new THREE.Vector3().crossVectors(ad, UP).normalize();
      ad.applyAxisAngle(UP, yaw);
      ad.applyAxisAngle(right, pitch);
      if (Math.abs(ad.y) > 0.98) ad.y = Math.sign(ad.y) * 0.98;
      ad.normalize();
      if (inp.hit('KeyV')) { this.view = this.view === 'cockpit' ? 'chase' : 'cockpit'; }
      if (inp.wheel) this.camDist = THREE.MathUtils.clamp(this.camDist + inp.wheel * 2, 10, 40);
      const ki = a.input;
      if (inp.down('KeyW')) ki.throttle = Math.min(1.1, ki.throttle + dt * 0.6);
      if (inp.down('KeyS')) ki.throttle = Math.max(0, ki.throttle - dt * 0.6);
      ki.roll = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
      ki.yaw = (inp.down('KeyE') ? 1 : 0) - (inp.down('KeyQ') ? 1 : 0);
      ki.pitch = (inp.down('ArrowDown') ? 1 : 0) - (inp.down('ArrowUp') ? 1 : 0);
      ki.guns = inp.lmb && inp.locked;
      ki.bomb = inp.down('Space');
      ki.rocket = inp.rmb || inp.down('KeyR');
      ki.aim = ad.clone();
      if (ki.roll !== 0 || ki.pitch !== 0) {
        // keyboard flight: aim follows the nose
        ad.lerp(a.forward(), Math.min(1, dt * 3)).normalize();
      }
    }
  }

  private issueOrders(t: Tank) {
    const inp = this.input;
    const kind = inp.hit('KeyZ') ? 'attack' : inp.hit('KeyX') ? 'follow' : inp.hit('KeyC') ? 'defend' : null;
    if (!kind) return;
    if (t.mods.radio <= 0.12) { this.notice('Radio out of action — cannot issue orders', 'bad'); audio.ui('error'); return; }
    const msg: { t: string; team: Team; kind: string; targetId?: string; leaderId?: string; point?: number } = { t: 'order', team: t.team, kind };
    if (kind === 'attack') {
      let best: Vehicle | null = null, ba = 0.15;
      const camDir = this.camera.getWorldDirection(new THREE.Vector3());
      for (const v of this.vehicles.values()) {
        if (v.team === t.team || !v.alive || !this.mySpotted.has(v.id)) continue;
        const d = v.pos.clone().sub(this.camera.position).normalize();
        const ang = Math.acos(Math.min(1, d.dot(camDir)));
        if (ang < ba) { ba = ang; best = v; }
      }
      if (!best) { this.notice('No spotted enemy under the crosshair', 'warn'); return; }
      msg.targetId = best.id;
      this.notice(`Order: attack ${best.name} (${best.spec.name})`, 'info');
    } else if (kind === 'follow') {
      msg.leaderId = t.id;
      this.notice('Order: AI tanks, follow me!', 'info');
    } else {
      let bi = 0, bd = 1e9;
      this.points.forEach((p, i) => { const d = Math.hypot(p.x - this.aimPoint.x, p.z - this.aimPoint.z); if (d < bd) { bd = d; bi = i; } });
      msg.point = bi;
      this.notice(`Order: capture / defend ${String.fromCharCode(65 + bi)} — ${this.points[bi].name}`, 'info');
    }
    audio.ui('select');
    this.send({ ...msg, from: this.myId });
    if (this.session.isHost) this.applyOrder(msg as never);
  }

  respawn(vehicleId: string) {
    const me = this.me;
    if (!me || me.alive || this.time < this.respawnAt) return false;
    if (!allowedVehicles(me.team, this.settings).find((v) => v.id === vehicleId)) return false;
    if (getVehicle(vehicleId).kind === 'aircraft') {
      const air = [...this.vehicles.values()].filter((o) => o.team === me.team && o.alive && o.kind === 'aircraft' && o !== me).length;
      if (air >= 3) { this.notice('Air slots full (max 3 aircraft per team)', 'warn'); return false; }
    }
    this.respawnChoice = vehicleId;
    this.respawnLocal(me, false, vehicleId);
    return true;
  }

  get respawnIn(): number { return Math.max(0, this.respawnAt - this.time); }

  // ============================================================ camera

  private updateCamera(dt: number) {
    const me = this.me;
    const cam = this.camera;
    let fov = 70;
    if (me && me.kind === 'tank') {
      const t = me as Tank;
      const camDir = new THREE.Vector3(Math.sin(this.camYaw) * Math.cos(this.camPitch), Math.sin(this.camPitch), Math.cos(this.camYaw) * Math.cos(this.camPitch));
      t.root.visible = this.view !== 'gunner' || !t.alive;
      if (this.view === 'gunner' && t.alive) {
        const lay = getLayout(t.tspec);
        t.root.updateMatrixWorld(true);
        const eye = t.model.turret.localToWorld(lay.trunnion.clone().add(new THREE.Vector3(0, 0.25, 0.3)));
        cam.position.copy(eye);
        cam.lookAt(eye.clone().add(camDir));
        fov = 70 / this.zoom;
      } else if (this.view === 'driver' && t.alive) {
        const lay = getLayout(t.tspec);
        const seat = lay.seats.find((s) => s.roles.includes('driver'));
        const eye = t.localToWorld(new THREE.Vector3(seat ? seat.pos.x : 0, t.tspec.hull.H + 0.25, (seat ? seat.pos.z : 0) + 0.4));
        cam.position.copy(eye);
        // look relative to hull, limited
        const rel = THREE.MathUtils.clamp(Math.atan2(Math.sin(this.camYaw - t.yaw), Math.cos(this.camYaw - t.yaw)), -1.1, 1.1);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.camPitch * 0.5, rel, 0, 'YXZ'));
        const look = new THREE.Vector3(0, 0, 1).applyQuaternion(q).applyQuaternion(t.quat);
        cam.lookAt(eye.clone().add(look));
        fov = 75;
      } else {
        const target = t.pos.clone().add(new THREE.Vector3(0, t.tspec.hull.H + 1.3, 0));
        const want = target.clone().addScaledVector(camDir, -this.camDist);
        const gy = this.world.height(want.x, want.z) + 0.8;
        if (want.y < gy) want.y = gy;
        cam.position.lerp(want, Math.min(1, dt * 18));
        if (cam.position.distanceTo(want) > 30) cam.position.copy(want);
        cam.lookAt(target.clone().addScaledVector(camDir, 10));
      }
      // aim point from the screen centre
      const o = cam.position.clone();
      const d = cam.getWorldDirection(new THREE.Vector3());
      const startOff = this.view === 'third' ? this.camDist + 2 : 1;
      o.addScaledVector(d, startOff);
      let best = 2500;
      const wh = this.world.raycast(o, d, best);
      if (wh) best = wh.t;
      let pv: typeof this.penPreview = null;
      for (const v of this.vehicles.values()) {
        if (v === t || v.kind !== 'tank' || !v.root.visible) continue;
        const ot = v as Tank;
        const lo = ot.worldToLocal(o), ld = ot.dirToLocal(d);
        const h = intersectTank(ot.tspec, lo, ld, ot.turretYaw, ot.gunPitch, best);
        if (h && h.t < best) {
          best = h.t;
          pv = v.team !== t.team && v.alive ? previewShot(ot.tspec, lo, ld, t.loadedAmmo, h.t + startOff, ot.turretYaw, ot.gunPitch) : null;
        }
      }
      this.penPreview = pv;
      this.aimPoint.copy(o).addScaledVector(d, best);
      // where the gun is actually pointing
      const mp = new THREE.Vector3(), md = new THREE.Vector3();
      t.muzzle(mp, md);
      const dist = Math.max(20, mp.distanceTo(this.aimPoint));
      this.gunPoint = mp.addScaledVector(md, dist);
      // gravity compensation is applied by the gun elevation; show the projected impact at aim distance
      const v0 = t.loadedAmmo.velocity || 600;
      const tof = dist / v0;
      this.gunPoint.y -= 0.5 * 9.81 * tof * tof;
    } else if (me && me.kind === 'aircraft') {
      const a = me as Aircraft;
      const cockpit = this.view === 'cockpit' && a.alive;
      a.model.cockpit.visible = cockpit;
      if (cockpit !== this.cockpitOn) {
        this.cockpitOn = cockpit;
        a.root.traverse((o) => { if (o !== a.root && o.parent === a.root && o !== a.model.cockpit) o.visible = !cockpit; });
      }
      if (cockpit) {
        const cz = a.aspec.engines === 2 ? a.aspec.length * 0.25 : a.aspec.length * 0.02;
        const eye = a.pos.clone().add(new THREE.Vector3(0, 0.95, cz).applyQuaternion(a.quat));
        cam.position.copy(eye);
        cam.quaternion.copy(a.quat).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI));
        fov = 75;
      } else {
        const d = a.alive ? a.aimDir : a.forward();
        const want = a.pos.clone().addScaledVector(d, -this.camDist * 1.4).add(new THREE.Vector3(0, this.camDist * 0.25, 0));
        const gy = this.world.height(want.x, want.z) + 2;
        if (want.y < gy) want.y = gy;
        cam.position.lerp(want, Math.min(1, dt * 10));
        if (cam.position.distanceTo(want) > 80) cam.position.copy(want);
        cam.lookAt(a.pos.clone().addScaledVector(d, 60));
        fov = 72;
      }
      this.aimPoint.copy(a.pos).addScaledVector(a.aimDir, 500);
      this.gunPoint = a.pos.clone().addScaledVector(a.forward(), 450);
      this.bombImpact = a.bombs.some((b) => b.count > 0) ? predictBombImpact(a.pos, a.vel, this.world) : null;
      this.penPreview = null;
    }
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 14);
      if (Math.abs(cam.fov - fov) < 0.1) cam.fov = fov;
      cam.updateProjectionMatrix();
      this.effects.scale.value = (this.container.clientHeight * this.renderer.getPixelRatio()) / 2 / Math.tan((cam.fov * Math.PI) / 360);
    }
    this.camPos.copy(cam.position);
    // shadow camera follows the view
    const focus = me ? me.pos : cam.position;
    const sd = new THREE.Vector3(...this.world.map.def.theme.sunDir).normalize();
    this.sun.position.copy(focus).addScaledVector(sd, 300);
    this.sun.target.position.copy(focus);
    this.sky.position.copy(cam.position);
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    audio.setListener(cam.position, fwd, cam.up);
  }

  // ============================================================ loop

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    this.time += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 1) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }

    this.playerControl(dt);
    // AI
    for (const b of this.brains.values()) {
      const v = b instanceof TankBrain ? b.tank : (b as PlaneBrain).plane;
      if (!v.local) continue;
      b.update(dt, this);
    }
    for (const v of this.vehicles.values()) if (v.root.visible || v.local) v.update(dt, this);
    this.updateProjectiles(dt);
    this.world.update(dt, this.time);
    this.effects.update(dt);
    audio.tickAmbient(dt);
    if (this.session.isHost && !this.ended) this.hostUpdate(dt);
    else if (!this.ended) this.timeLeft -= dt;
    for (let i = 0; i < this.points.length; i++) this.world.setPointOwner(i, this.points[i].owner, this.points[i].progress);

    this.spotAcc += dt;
    if (this.spotAcc > 0.5) { this.spotAcc = 0; this.updateSpotting(); }
    // network snapshots
    this.snapAcc += dt;
    if (this.snapAcc >= TICK_SNAP) {
      this.snapAcc = 0;
      const e: (number | string)[][] = [];
      for (const v of this.vehicles.values()) if (v.local && v.root.visible) { const s = v.snapshot(); s.push(v.spec.id); e.push(s); }
      if (e.length) this.send({ t: 'st', e });
    }
    this.dsAcc += dt;
    if (this.dsAcc > 1) {
      this.dsAcc = 0;
      for (const v of this.vehicles.values()) if (v.local && v.kind === 'tank' && v.alive) {
        const t = v as Tank;
        this.send({ t: 'ds', id: t.id, c: t.dmg.crew.map(Math.round), m: t.dmg.modules.map(Math.round), s: Math.round(t.dmg.structure) });
      }
    }
    this.localWarnings();
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
    drawOverlay(this, this.octx, this.container.clientWidth, this.container.clientHeight);
    this.miniAcc += dt;
    if (this.miniAcc > 0.15 && this.minimap) { this.miniAcc = 0; drawMinimap(this, this.minimap); }
    this.hudAcc += dt;
    if (this.hudAcc > 0.1) { this.hudAcc = 0; this.pushHud(false); }
    this.input.endFrame();
  };

  private localWarnings() {
    const me = this.me;
    if (!me || me.kind !== 'tank' || !me.alive) return;
    const t = me as Tank;
    if (t.waterWarned) { t.waterWarned = false; this.notice('Engine flooded! Repair (R) on dry ground', 'bad'); }
    if (t.dmg.fire > 0 && this.time - this.lastAlarm > 4) { this.lastAlarm = this.time; audio.alarm(); }
  }

  notice(text: string, kind: Notice['kind']) {
    this.notices.push({ id: this.noticeId++, text, kind, time: this.time });
    if (this.notices.length > 6) this.notices.shift();
  }

  /** Compile the React HUD state. */
  pushHud(force: boolean) {
    void force;
    const me = this.me;
    const now = this.time;
    this.notices = this.notices.filter((n) => now - n.time < 6);
    this.hitMarkers = this.hitMarkers.filter((h) => now - h.time < 1.6);
    this.damageIndicators = this.damageIndicators.filter((d) => now - d.time < 3);
    const sb: ScoreRow[] = this.roster.map((r) => {
      const st = this.stats.get(r.id) ?? { k: 0, d: 0, s: 0, caps: 0 };
      const v = this.vehicles.get(r.id);
      return { id: r.id, name: r.name, team: r.team, kills: st.k, deaths: st.d, score: st.s, caps: st.caps, vehicle: v?.spec.name ?? '', alive: !!v?.alive, isBot: r.isBot, isMe: r.id === this.myId };
    });
    const patch: Partial<import('./hud').HudState> = {
      myTeam: this.myTeam, view: this.view, zoom: this.zoom, tickets: [...this.tickets] as [number, number], timeLeft: Math.max(0, this.timeLeft),
      points: this.points.map((p) => ({ name: p.name, owner: p.owner, progress: p.progress, contested: p.contested, inside: !!me && me.alive && Math.hypot(me.pos.x - p.x, me.pos.z - p.z) < p.r, dist: me ? Math.round(Math.hypot(me.pos.x - p.x, me.pos.z - p.z)) : 0 })),
      killfeed: this.killfeed.filter((k) => now - k.time < 12).slice(), scoreboard: sb, notices: this.notices.slice(),
      incoming: this.incoming.slice(), lastIncoming: this.incoming[0] && now - this.incoming[0].time < 6 ? this.incoming[0] : null,
      outgoing: this.outgoing && now - this.outgoingTime < 5 ? this.outgoing : null,
      respawnIn: Math.ceil(this.respawnIn), fps: this.fps, isHost: this.session.isHost,
      orders: (() => { const o = this.teamBrain.orders[this.myTeam]; return o && o.until > now ? o.kind : ''; })(),
    };
    if (me) {
      patch.kind = me.kind;
      patch.myVehicleId = me.spec.id;
      if (me.kind === 'tank') {
        const t = me as Tank;
        const s = t.tspec;
        const lay = getLayout(s);
        const g = s.gun;
        const reloadTotal = t.clip > 0 && g.clip ? g.clip.interval : g.reload;
        patch.speedKmh = Math.round(Math.abs(t.speed) * 3.6) * Math.sign(t.speed || 1);
        patch.throttle = t.input.throttle;
        patch.ammo = g.ammo.map((id, i) => ({ id, short: AMMO[id].short, name: AMMO[id].name, selected: i === t.selected, loaded: i === t.loaded && t.reload <= 0, pen: Math.round(AMMO[id].pen100) }));
        patch.reloadFrac = t.reload <= 0 ? 1 : 1 - t.reload / reloadTotal;
        patch.reloadLeft = Math.max(0, t.reload * t.mods.reload);
        patch.clip = t.clip; patch.clipSize = g.clip?.size ?? 0;
        patch.rounds = Math.max(0, Math.round(t.rounds));
        patch.crew = lay.seats.map((seat, i) => {
          const covering = seat.roles.filter(() => true);
          return { seat: i, roles: seat.roles, hp: Math.round(t.dmg.crew[i]), status: crewStatusLabel(t.dmg.crew[i]), covering };
        });
        patch.modules = lay.modules.map((m, i) => ({ idx: i, type: m.type, name: m.name, frac: t.dmg.modules[i] / m.maxHp, rounds: m.rounds !== undefined ? t.dmg.rounds[i] : undefined }));
        patch.fire = t.dmg.fire > 0;
        patch.extinguishers = t.dmg.extinguishers; patch.medkits = t.dmg.medkits; patch.medkitsAllowed = this.rules.medkits;
        patch.repairFrac = t.dmg.repairing > 0 ? 1 - t.dmg.repairing / Math.max(0.01, t.repairTotal) : 0;
        patch.extFrac = t.dmg.extinguishing > 0 ? 1 - t.dmg.extinguishing / t.extTotal : 0;
        patch.baseFrac = t.baseTimer / 6;
        patch.structure = t.dmg.structure / t.dmg.maxStructure;
        patch.effects = {
          gunner: roleStatus(s, t.dmg, 'gunner').eff, loader: roleStatus(s, t.dmg, 'loader').eff, driver: roleStatus(s, t.dmg, 'driver').eff,
          commander: roleStatus(s, t.dmg, 'commander').eff, radio: Math.min(roleStatus(s, t.dmg, 'radio').eff, t.mods.radio),
        };
        patch.turretYaw = t.turretYaw; patch.hullYaw = t.yaw; patch.camYaw = this.camYaw;
        const w: string[] = [];
        if (!t.mods.trackL || !t.mods.trackR) w.push('TRACK BROKEN — press R to repair');
        if (t.mods.power <= 0) w.push('ENGINE DESTROYED');
        if (t.mods.maxSpeed <= 0) w.push('TRANSMISSION DESTROYED');
        if (!t.mods.canFire && t.alive) w.push(t.rounds <= 0 ? 'OUT OF AMMUNITION' : 'GUN INOPERABLE');
        if (t.mods.radio < 0.15) w.push('RADIO OUT — no team spotting');
        patch.warnings = w;
      } else {
        const a = me as Aircraft;
        patch.alt = Math.round(a.pos.y - this.world.height(a.pos.x, a.pos.z));
        patch.airspeed = Math.round(a.speed * 3.6);
        patch.planeThrottle = a.input.throttle;
        patch.planeHp = a.hp / a.aspec.hp; patch.engineHp = a.engineHp / 100;
        patch.bombs = a.bombs.reduce((x, b) => x + b.count, 0);
        patch.rockets = a.rockets;
        patch.gunAmmo = a.ammo.reduce((x, y) => x + y, 0);
        patch.gLoad = Math.round(a.gLoad * 10) / 10;
        patch.stall = a.speed < a.stallV * 1.05;
        const ahead = a.pos.clone().addScaledVector(a.vel, 4);
        patch.pullUp = ahead.y - this.world.height(ahead.x, ahead.z) < 30 && a.alive;
        patch.fire = a.fire > 0;
        const w: string[] = [];
        if (a.engineHp <= 0) w.push('ENGINE DEAD — glide!');
        if (a.fire > 0) w.push('AIRCRAFT ON FIRE');
        if (a.pilot < 50) w.push('PILOT WOUNDED');
        patch.warnings = w;
      }
      if (!me.alive && !this.ended) patch.phase = 'dead';
      else if (!this.ended) patch.phase = 'playing';
    }
    this.hud.set(patch);
  }

  // ============================================================ teardown

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.session.gameHandler = null;
    this.session.hostChangeHandler = null;
    this.session.peersHandler = null;
    for (const v of this.vehicles.values()) v.dispose(this);
    this.vehicles.clear();
    for (const p of this.projs) if (p.mesh) this.scene.remove(p.mesh);
    this.effects.dispose();
    this.world.dispose();
    this.input.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }

  get respawnVehicle() { return this.respawnChoice; }
}

function r3(v: THREE.Vector3, k = 100): [number, number, number] {
  return [Math.round(v.x * k) / k, Math.round(v.y * k) / k, Math.round(v.z * k) / k];
}
