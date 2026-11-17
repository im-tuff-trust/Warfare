import { getMap } from '../data/maps';
import { AIRCRAFT, TANKS, type Nation, type VehicleSpec } from '../data/vehicles';
import { createRoomCode, fetchConfig, makeTransport, normalizeCode, type PeerInfo, type Transport } from './transport';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface LobbySettings {
  map: string; tickets: number; teamSize: number; difficulty: Difficulty;
  medkits: boolean; crewReplacement: boolean; historical: boolean; aircraft: boolean; waitSeconds: number; timeLimit: number;
}

export interface LobbyPlayer { id: string; name: string; team: 0 | 1; vehicleId: string; ready: boolean; }
export interface RosterEntry { id: string; name: string; team: 0 | 1; vehicleId: string; isBot: boolean; }
export interface StartInfo { settings: LobbySettings; seed: number; roster: RosterEntry[]; startedAt: number; late?: boolean; }

export interface LobbyState {
  code: string; hostId: string; players: LobbyPlayer[]; settings: LobbySettings; autoStartAt: number; phase: 'lobby' | 'game';
}

export const DEFAULT_SETTINGS: LobbySettings = {
  map: 'normandy', tickets: 400, teamSize: 6, difficulty: 'normal', medkits: true, crewReplacement: true, historical: true, aircraft: true, waitSeconds: 30, timeLimit: 15,
};

export const TEAM_NAMES = ['Allies', 'Axis'] as const;

export function teamNations(team: 0 | 1, s: LobbySettings): Nation[] {
  if (team === 1) return ['GER'];
  return s.historical ? [getMap(s.map).allies] : ['USA', 'USSR'];
}

export function allowedVehicles(team: 0 | 1, s: LobbySettings): VehicleSpec[] {
  const n = teamNations(team, s);
  const list: VehicleSpec[] = TANKS.filter((t) => n.includes(t.nation));
  if (s.aircraft) list.push(...AIRCRAFT.filter((a) => n.includes(a.nation)));
  return list;
}

export function defaultVehicle(team: 0 | 1, s: LobbySettings): string {
  const l = allowedVehicles(team, s);
  return (l.find((v) => v.kind === 'tank' && v.cls === 'medium') ?? l[0]).id;
}

const SURNAMES: Record<Nation, string[]> = {
  GER: ['Becker', 'Krüger', 'Hoffmann', 'Wagner', 'Schulz', 'Richter', 'Vogel', 'Lange', 'Brandt', 'Keller', 'Hartmann', 'Fuchs'],
  USSR: ['Petrov', 'Ivanov', 'Smirnov', 'Volkov', 'Morozov', 'Orlov', 'Sokolov', 'Lebedev', 'Kozlov', 'Pavlov', 'Belov', 'Titov'],
  USA: ['Miller', 'Johnson', 'Walker', 'Harris', 'Cooper', 'Turner', 'Brooks', 'Hayes', 'Bennett', 'Foster', 'Reed', 'Porter'],
};
const RANKS: Record<Nation, string[]> = { GER: ['Uffz.', 'Fw.', 'Lt.', 'Ofw.'], USSR: ['Sgt.', 'Lt.', 'Jr.Lt.', 'Cpt.'], USA: ['Sgt.', 'Lt.', 'Cpl.', 'Cpt.'] };

/** Fill both teams up to teamSize with AI, using a sensible class mix. */
export function buildRoster(players: LobbyPlayer[], s: LobbySettings, rnd: () => number = Math.random): RosterEntry[] {
  const roster: RosterEntry[] = players.map((p) => ({ id: p.id, name: p.name, team: p.team, vehicleId: p.vehicleId, isBot: false }));
  const used = new Set<string>();
  for (const team of [0, 1] as const) {
    const have = roster.filter((r) => r.team === team);
    const need = Math.max(0, s.teamSize - have.length);
    const allowed = allowedVehicles(team, s);
    const pick = (cls: string) => {
      const c = allowed.filter((v) => v.cls === cls);
      return c.length ? c[Math.floor(rnd() * c.length)].id : null;
    };
    const mix = s.aircraft ? ['medium', 'heavy', 'fighter', 'light', 'medium', 'bomber', 'heavy', 'medium', 'light', 'medium', 'heavy', 'fighter'] : ['medium', 'heavy', 'light', 'medium', 'heavy', 'medium', 'light', 'medium'];
    let air = have.filter((h) => allowed.find((a) => a.id === h.vehicleId)?.kind === 'aircraft').length;
    for (let i = 0; i < need; i++) {
      let cls = mix[i % mix.length];
      if ((cls === 'fighter' || cls === 'bomber') && air >= 2) cls = 'medium';
      const vid = pick(cls) ?? defaultVehicle(team, s);
      if (cls === 'fighter' || cls === 'bomber') air++;
      const nat = allowed.find((v) => v.id === vid)!.nation;
      let name = '';
      for (let k = 0; k < 20; k++) {
        name = RANKS[nat][Math.floor(rnd() * RANKS[nat].length)] + ' ' + SURNAMES[nat][Math.floor(rnd() * SURNAMES[nat].length)];
        if (!used.has(name)) break;
      }
      used.add(name);
      roster.push({ id: `bot${team}_${i}_${Math.floor(rnd() * 1e6)}`, name: '[AI] ' + name, team, vehicleId: vid, isBot: true });
    }
  }
  return roster;
}

type Listener = () => void;

/** Lobby/session controller. The host is authoritative for lobby state and AI. */
export class Session {
  transport: Transport;
  code = '';
  hostId = '';
  peers: PeerInfo[] = [];
  lobby!: LobbyState;
  myName: string;
  start: StartInfo | null = null;
  error = '';
  private listeners = new Set<Listener>();
  gameHandler: ((from: string, msg: any) => void) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  hostChangeHandler: ((hostId: string) => void) | null = null;
  peersHandler: ((peers: PeerInfo[]) => void) | null = null;
  onStart: ((s: StartInfo) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  private constructor(t: Transport, name: string) { this.transport = t; this.myName = name; }
  get myId() { return this.transport.id; }
  get isHost() { return this.hostId === this.transport.id; }
  get mode() { return this.transport.mode; }

  static async create(name: string): Promise<Session> {
    const cfg = await fetchConfig();
    const code = await createRoomCode();
    const s = new Session(makeTransport(cfg), name);
    await s.connect(code, true);
    return s;
  }

  static async join(rawCode: string, name: string): Promise<Session> {
    const code = normalizeCode(rawCode);
    if (code.length !== 6) throw new Error('Room codes are 6 characters long.');
    const cfg = await fetchConfig();
    const s = new Session(makeTransport(cfg), name);
    await s.connect(code, false);
    return s;
  }

  private async connect(code: string, create: boolean) {
    this.code = code;
    this.transport.onMessage((from, msg) => this.handle(from, msg));
    this.transport.onPeers((peers, host) => this.onPeers(peers, host));
    this.transport.onClose((r) => { this.error = r; this.emit(); });
    const res = await this.transport.connect(code, create, this.myName);
    this.peers = res.peers;
    this.hostId = res.hostId;
    const settings = { ...DEFAULT_SETTINGS };
    this.lobby = { code, hostId: this.hostId, players: [], settings, autoStartAt: Date.now() + settings.waitSeconds * 1000, phase: 'lobby' };
    if (this.isHost) {
      this.lobby.players.push({ id: this.myId, name: this.myName, team: 0, vehicleId: defaultVehicle(0, settings), ready: false });
      this.broadcastLobby();
    } else {
      this.transport.send({ t: 'hello', name: this.myName });
    }
    this.timer = setInterval(() => this.tick(), 250);
    this.emit();
  }

  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit() { this.seq++; this.listeners.forEach((l) => l()); }
  get version() { return this.seq; }

  send(data: unknown, to?: string) { this.transport.send(data, to); }

  private onPeers(peers: PeerInfo[], host: string) {
    const prevHost = this.hostId;
    this.peers = peers;
    this.hostId = host;
    if (this.lobby) this.lobby.hostId = host;
    const ids = new Set(peers.map((p) => p.id));
    if (this.isHost && this.lobby) {
      // drop departed players; add newcomers
      this.lobby.players = this.lobby.players.filter((p) => ids.has(p.id));
      for (const p of peers) if (!this.lobby.players.find((x) => x.id === p.id)) this.addPlayer(p.id, p.name);
      if (this.lobby.phase === 'game' && this.start) {
        for (const p of peers) {
          if (p.id !== this.myId && !this.start.roster.find((r) => r.id === p.id)) this.lateJoin(p.id, p.name);
        }
      }
      this.broadcastLobby();
    }
    if (prevHost !== host) this.hostChangeHandler?.(host);
    this.peersHandler?.(peers);
    this.emit();
  }

  private addPlayer(id: string, name: string) {
    const t0 = this.lobby.players.filter((p) => p.team === 0).length;
    const t1 = this.lobby.players.filter((p) => p.team === 1).length;
    const team: 0 | 1 = t1 < t0 ? 1 : 0;
    this.lobby.players.push({ id, name, team, vehicleId: defaultVehicle(team, this.lobby.settings), ready: false });
    // a new arrival buys everyone a bit more time to choose
    this.lobby.autoStartAt = Math.max(this.lobby.autoStartAt, Date.now() + 15000);
  }

  private lateJoin(id: string, name: string) {
    if (!this.start) return;
    const humans = (t: number) => this.start!.roster.filter((r) => r.team === t && !r.isBot).length;
    const team: 0 | 1 = humans(1) < humans(0) ? 1 : 0;
    const entry: RosterEntry = { id, name, team, vehicleId: defaultVehicle(team, this.start.settings), isBot: false };
    // replace one bot of that team to keep teams balanced
    const bot = this.start.roster.find((r) => r.team === team && r.isBot);
    if (bot) {
      this.start.roster = this.start.roster.filter((r) => r !== bot);
      this.gameHandler?.(this.myId, { t: 'removeBot', id: bot.id });
      this.send({ t: 'removeBot', id: bot.id });
    }
    this.start.roster.push(entry);
    this.send({ t: 'start', info: { ...this.start, late: true } }, id);
    this.send({ t: 'rosterAdd', entry });
    this.gameHandler?.(this.myId, { t: 'rosterAdd', entry });
  }

  private broadcastLobby() {
    if (!this.isHost) return;
    this.send({ t: 'lobby', lobby: this.lobby, remainingMs: this.lobby.autoStartAt - Date.now() });
    this.emit();
  }

  private handle(from: string, msg: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        if (this.isHost) {
          const p = this.lobby.players.find((x) => x.id === from);
          if (p) p.name = String(msg.name).slice(0, 20);
          else this.addPlayer(from, String(msg.name).slice(0, 20));
          this.broadcastLobby();
        }
        return;
      case 'lobby':
        if (from === this.hostId || !this.isHost) {
          this.lobby = msg.lobby;
          // host clocks may differ: convert the remaining time to our local clock
          if (typeof msg.remainingMs === 'number') this.lobby.autoStartAt = Date.now() + msg.remainingMs;
          this.emit();
        }
        return;
      case 'pref':
        if (this.isHost) this.applyPref(from, msg);
        return;
      case 'start':
        if (!this.start || msg.info.late || msg.info.startedAt !== this.start.startedAt) this.beginGame(msg.info);
        return;
      default:
        this.gameHandler?.(from, msg);
    }
  }

  private applyPref(id: string, msg: { team?: 0 | 1; vehicleId?: string; ready?: boolean }) {
    const p = this.lobby.players.find((x) => x.id === id);
    if (!p) return;
    if (msg.team === 0 || msg.team === 1) {
      if (msg.team !== p.team) { p.team = msg.team; p.vehicleId = defaultVehicle(p.team, this.lobby.settings); }
    }
    if (msg.vehicleId && allowedVehicles(p.team, this.lobby.settings).find((v) => v.id === msg.vehicleId)) p.vehicleId = msg.vehicleId;
    if (typeof msg.ready === 'boolean') p.ready = msg.ready;
    this.broadcastLobby();
  }

  /** Change my own lobby preferences. */
  setPref(pref: { team?: 0 | 1; vehicleId?: string; ready?: boolean }) {
    if (this.isHost) this.applyPref(this.myId, pref);
    else {
      this.send({ t: 'pref', ...pref });
      // optimistic local update
      const p = this.lobby.players.find((x) => x.id === this.myId);
      if (p) {
        if (pref.team !== undefined && pref.team !== p.team) { p.team = pref.team; p.vehicleId = defaultVehicle(p.team, this.lobby.settings); }
        if (pref.vehicleId) p.vehicleId = pref.vehicleId;
        if (pref.ready !== undefined) p.ready = pref.ready;
      }
      this.emit();
    }
  }

  setSettings(s: Partial<LobbySettings>) {
    if (!this.isHost) return;
    const prev = this.lobby.settings;
    this.lobby.settings = { ...prev, ...s };
    // keep everyone's vehicle legal under the new rules
    for (const p of this.lobby.players) {
      if (!allowedVehicles(p.team, this.lobby.settings).find((v) => v.id === p.vehicleId)) p.vehicleId = defaultVehicle(p.team, this.lobby.settings);
    }
    if (s.waitSeconds !== undefined) this.lobby.autoStartAt = Date.now() + s.waitSeconds * 1000;
    this.broadcastLobby();
  }

  extendWait(seconds: number) {
    if (!this.isHost) return;
    this.lobby.autoStartAt = Math.max(this.lobby.autoStartAt, Date.now()) + seconds * 1000;
    this.broadcastLobby();
  }

  startNow() {
    if (!this.isHost || this.lobby.phase !== 'lobby') return;
    const info: StartInfo = {
      settings: this.lobby.settings,
      seed: Math.floor(Math.random() * 1e9),
      roster: buildRoster(this.lobby.players, this.lobby.settings),
      startedAt: Date.now(),
    };
    this.lobby.phase = 'game';
    this.broadcastLobby();
    this.send({ t: 'start', info });
    this.beginGame(info);
  }

  private beginGame(info: StartInfo) {
    this.start = info;
    if (this.lobby) this.lobby.phase = 'game';
    this.onStart?.(info);
    this.emit();
  }

  /** Called when the match ends and players return to the lobby. */
  backToLobby() {
    this.start = null;
    if (this.lobby) {
      this.lobby.phase = 'lobby';
      this.lobby.autoStartAt = Date.now() + this.lobby.settings.waitSeconds * 1000;
      for (const p of this.lobby.players) p.ready = false;
    }
    if (this.isHost) this.broadcastLobby();
    this.emit();
  }

  private tickN = 0;
  private tick() {
    if (!this.lobby) return;
    if (!this.isHost) { if (this.lobby.phase === 'lobby') this.emit(); return; }
    if (this.lobby.phase !== 'lobby') return;
    if (++this.tickN % 4 === 0) this.broadcastLobby();
    const humans = this.lobby.players;
    const allReady = humans.length > 1 && humans.every((p) => p.ready);
    if (allReady && this.lobby.autoStartAt - Date.now() > 3000) { this.lobby.autoStartAt = Date.now() + 3000; this.broadcastLobby(); }
    if (Date.now() >= this.lobby.autoStartAt) this.startNow();
  }

  /** Remaining seconds before the lobby auto-starts with AI filling empty slots. */
  remaining(): number { return this.lobby ? Math.max(0, Math.ceil((this.lobby.autoStartAt - Date.now()) / 1000)) : 0; }

  leave() {
    if (this.timer) clearInterval(this.timer);
    this.transport.close();
    this.listeners.clear();
  }
}
