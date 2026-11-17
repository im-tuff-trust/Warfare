import type { HitReport } from './sim/damage';
import type { ModuleType } from './sim/layout';
import type { Role } from './data/vehicles';

export interface HudCrew { seat: number; roles: Role[]; hp: number; status: string; covering: Role[]; }
export interface HudModule { idx: number; type: ModuleType; name: string; frac: number; rounds?: number; }
export interface KillFeedItem { id: number; killer: string; victim: string; kt: number; vt: number; how: string; time: number; mine: boolean; }
export interface ScoreRow { id: string; name: string; team: number; kills: number; deaths: number; score: number; caps: number; vehicle: string; alive: boolean; isBot: boolean; isMe: boolean; }
export interface PointHud { name: string; owner: number; progress: number; contested: boolean; inside: boolean; dist: number; }
export interface Notice { id: number; text: string; kind: 'info' | 'good' | 'bad' | 'warn'; time: number; }

export interface HudState {
  phase: 'loading' | 'playing' | 'dead' | 'ended';
  roomCode: string; mode: 'online' | 'local'; isHost: boolean;
  myTeam: number; myVehicleId: string; kind: 'tank' | 'aircraft';
  view: string; zoom: number;
  // tank
  speedKmh: number; throttle: number;
  ammo: { id: string; short: string; name: string; selected: boolean; loaded: boolean; pen: number }[];
  reloadFrac: number; reloadLeft: number; clip: number; clipSize: number; rounds: number;
  crew: HudCrew[]; modules: HudModule[];
  fire: boolean; extinguishers: number; medkits: number; medkitsAllowed: boolean;
  repairFrac: number; extFrac: number; baseFrac: number; structure: number;
  effects: { gunner: number; loader: number; driver: number; commander: number; radio: number };
  turretYaw: number; hullYaw: number; camYaw: number;
  // aircraft
  alt: number; airspeed: number; planeThrottle: number; planeHp: number; engineHp: number; bombs: number; rockets: number; gunAmmo: number; gLoad: number; stall: boolean; pullUp: boolean;
  // match
  tickets: [number, number]; maxTickets: number; timeLeft: number; points: PointHud[];
  killfeed: KillFeedItem[]; scoreboard: ScoreRow[];
  incoming: HitReport[]; lastIncoming: HitReport | null; outgoing: HitReport | null;
  notices: Notice[];
  respawnIn: number; killedBy: string;
  winner: number; endReason: string;
  warnings: string[];
  orders: string;
  fps: number; ping: number;
}

export const initialHud = (): HudState => ({
  phase: 'loading', roomCode: '', mode: 'local', isHost: false, myTeam: 0, myVehicleId: '', kind: 'tank', view: 'third', zoom: 1,
  speedKmh: 0, throttle: 0, ammo: [], reloadFrac: 1, reloadLeft: 0, clip: 0, clipSize: 0, rounds: 0, crew: [], modules: [],
  fire: false, extinguishers: 0, medkits: 0, medkitsAllowed: true, repairFrac: 0, extFrac: 0, baseFrac: 0, structure: 1,
  effects: { gunner: 1, loader: 1, driver: 1, commander: 1, radio: 1 }, turretYaw: 0, hullYaw: 0, camYaw: 0,
  alt: 0, airspeed: 0, planeThrottle: 0, planeHp: 1, engineHp: 1, bombs: 0, rockets: 0, gunAmmo: 0, gLoad: 1, stall: false, pullUp: false,
  tickets: [0, 0], maxTickets: 1, timeLeft: 0, points: [], killfeed: [], scoreboard: [], incoming: [], lastIncoming: null, outgoing: null,
  notices: [], respawnIn: 0, killedBy: '', winner: -1, endReason: '', warnings: [], orders: '', fps: 0, ping: 0,
});

type L = () => void;

export class HudStore {
  state: HudState = initialHud();
  private ls = new Set<L>();
  subscribe = (l: L) => { this.ls.add(l); return () => { this.ls.delete(l); }; };
  get = () => this.state;
  set(patch: Partial<HudState>) { this.state = { ...this.state, ...patch }; this.ls.forEach((l) => l()); }
}
