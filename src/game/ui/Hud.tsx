'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Game } from '../game';
import type { HudStore } from '../hud';
import { CLASS_LABEL, ROLE_NAMES, getVehicle, type Role, type TankSpec } from '../data/vehicles';
import { getLayout } from '../sim/layout';
import { crewStatusLabel, type HitReport } from '../sim/damage';
import { allowedVehicles, TEAM_NAMES } from '../net/session';
import type { Tank } from '../entities';
import { Cutaway, hpColor } from './Cutaway';

const RESULT_LABEL: Record<string, string> = { ricochet: 'RICOCHET', nonpen: 'NON-PENETRATION', partial: 'PARTIAL PENETRATION', pen: 'PENETRATION', module: 'COMPONENT HIT', blast: 'BLAST DAMAGE' };
const RESULT_CLASS: Record<string, string> = { ricochet: 'r-rico', nonpen: 'r-none', partial: 'r-part', pen: 'r-pen', module: 'r-part', blast: 'r-pen' };

function fmtTime(s: number) { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${r.toString().padStart(2, '0')}`; }

export default function Hud({ game, store, onLeave }: { game: Game; store: HudStore; onLeave: () => void }) {
  const h = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [interior, setInterior] = useState(false);
  const [board, setBoard] = useState(false);
  const [help, setHelp] = useState(false);
  const [locked, setLocked] = useState(false);
  const miniRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { game.minimap = miniRef.current; }, [game]);
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'KeyI') setInterior((v) => !v);
      if (e.code === 'Tab') { e.preventDefault(); setBoard(true); }
      if (e.code === 'F1') { e.preventDefault(); setHelp((v) => !v); }
    };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Tab') setBoard(false); };
    const plc = () => setLocked(!!document.pointerLockElement);
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    document.addEventListener('pointerlockchange', plc);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); document.removeEventListener('pointerlockchange', plc); };
  }, []);

  const spec = h.myVehicleId ? getVehicle(h.myVehicleId) : null;
  const tank = spec?.kind === 'tank' ? (spec as TankSpec) : null;
  const me = game.me as Tank | undefined;

  return (
    <div className="hud">
      {/* -------- top bar: tickets, timer, objectives */}
      <div className="topbar">
        <div className="tix allies"><span>{TEAM_NAMES[0]}</span><b>{h.tickets[0]}</b><i style={{ width: `${(100 * h.tickets[0]) / h.maxTickets}%` }} /></div>
        <div className="objectives">
          {h.points.map((p, i) => (
            <div key={i} className={`obj o${p.owner} ${p.contested ? 'contested' : ''} ${p.inside ? 'inside' : ''}`} title={p.name}>
              <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" className="ring" />
                <circle cx="18" cy="18" r="15" className={`prog ${p.progress >= 0 ? 'pa' : 'pb'}`} strokeDasharray={`${Math.abs(p.progress) * 94.2} 94.2`} transform="rotate(-90 18 18)" /></svg>
              <b>{String.fromCharCode(65 + i)}</b>
            </div>
          ))}
          <div className="timer">{fmtTime(h.timeLeft)}</div>
        </div>
        <div className="tix axis"><b>{h.tickets[1]}</b><span>{TEAM_NAMES[1]}</span><i style={{ width: `${(100 * h.tickets[1]) / h.maxTickets}%` }} /></div>
      </div>
      <div className="roominfo">ROOM <b>{h.roomCode}</b>{h.mode === 'local' ? ' · local' : ''}{h.isHost ? ' · host' : ''} · {h.fps} fps{h.orders ? ` · order: ${h.orders}` : ''}</div>

      {/* -------- kill feed */}
      <div className="killfeed">
        {h.killfeed.map((k) => (
          <div key={k.id} className={k.mine ? 'mine' : ''}>
            {k.killer && <span className={`t${k.kt}`}>{k.killer}</span>}
            <em>{k.killer ? (k.how === 'ammo detonation' ? '💥' : '✛') : '☠'}</em>
            <span className={`t${k.vt}`}>{k.victim}</span>
            {k.how && k.how !== 'destroyed' && <small>{k.how}</small>}
          </div>
        ))}
      </div>

      {/* -------- notices & warnings */}
      <div className="notices">
        {h.warnings.map((w) => <div key={w} className="warn big">{w}</div>)}
        {h.notices.map((n) => <div key={n.id} className={n.kind}>{n.text}</div>)}
      </div>
      {h.kind === 'aircraft' && h.phase === 'playing' && (h.pullUp || h.stall) && <div className="pullup">{h.pullUp ? 'PULL UP' : 'STALL'}</div>}

      {/* -------- minimap */}
      <canvas ref={miniRef} className="minimap" width={220} height={220} />

      {/* -------- vehicle panel */}
      {h.phase === 'playing' && tank && <TankPanel h={h} spec={tank} />}
      {h.phase === 'playing' && spec?.kind === 'aircraft' && (
        <div className="airpanel panel">
          <div className="vname">{spec.name} <small>{CLASS_LABEL[spec.cls]}</small></div>
          <div className="gauges">
            <div><label>IAS</label><b>{h.airspeed}</b><small>km/h</small></div>
            <div><label>ALT</label><b>{h.alt}</b><small>m</small></div>
            <div><label>THR</label><b>{Math.round(h.planeThrottle * 100)}</b><small>%{h.planeThrottle > 1 ? ' WEP' : ''}</small></div>
            <div><label>G</label><b>{h.gLoad}</b></div>
          </div>
          <Bar label="Airframe" f={h.planeHp} /><Bar label="Engine" f={h.engineHp} />
          <div className="ord"><span>GUNS <b>{h.gunAmmo}</b></span><span>BOMBS <b>{h.bombs}</b> <kbd>Space</kbd></span>{h.rockets > 0 && <span>RKT <b>{h.rockets}</b> <kbd>RMB</kbd></span>}</div>
        </div>
      )}

      {/* -------- incoming hit popup */}
      {h.phase === 'playing' && tank && h.lastIncoming && me && (
        <div className="hitpop panel">
          <HitCard rep={h.lastIncoming} spec={tank} crew={me.dmg.crew} modules={me.dmg.modules} title="HIT TAKEN" compact />
        </div>
      )}
      {/* -------- outgoing hit camera */}
      {h.outgoing && <OutgoingCam game={game} rep={h.outgoing} />}

      {/* -------- pointer lock prompt */}
      {!locked && h.phase === 'playing' && !interior && (
        <div className="lockprompt" onClick={() => game.input.requestLock()}>
          <div className="panel">
            <h3>Click to take command</h3>
            <p>Mouse aims · <kbd>Esc</kbd> releases the cursor · <kbd>F1</kbd> controls · <kbd>I</kbd> interior damage panel · hold <kbd>Tab</kbd> scoreboard</p>
            <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onLeave(); }}>Leave battle</button>
          </div>
        </div>
      )}

      {interior && me && tank && <InteriorPanel game={game} h={h} spec={tank} tank={me} onClose={() => setInterior(false)} />}
      {interior && (!tank || !me) && <div className="modal" onClick={() => setInterior(false)}><div className="panel"><p>The interior damage panel is available while commanding a tank.</p></div></div>}
      {board && <Scoreboard h={h} />}
      {help && <Controls onClose={() => setHelp(false)} />}
      {h.phase === 'dead' && <Respawn game={game} h={h} />}
      {h.phase === 'ended' && <EndScreen h={h} onLeave={onLeave} />}
    </div>
  );
}

function Bar({ label, f, warn }: { label: string; f: number; warn?: boolean }) {
  return <div className={`bar ${warn ? 'warnbar' : ''}`}><label>{label}</label><div><i style={{ width: `${Math.max(0, Math.min(1, f)) * 100}%`, background: hpColor(f) }} /></div></div>;
}

function TankPanel({ h, spec }: { h: ReturnType<HudStore['get']>; spec: TankSpec }) {
  const lay = getLayout(spec);
  const eff = h.effects;
  const pct = (x: number) => Math.round(x * 100);
  return (
    <>
      <div className="tankpanel panel">
        <div className="vname">{spec.name} <small>{CLASS_LABEL[spec.cls]}</small></div>
        <div className="speed"><b>{h.speedKmh}</b> km/h <small>{h.view.toUpperCase()} VIEW</small></div>
        <div className="ammo">
          {h.ammo.map((a, i) => (
            <div key={a.id} className={`shell ${a.selected ? 'sel' : ''} ${a.loaded ? 'loaded' : ''}`} title={`${a.name} · ${a.pen} mm @100m`}>
              <kbd>{i + 1}</kbd><b>{a.short}</b><small>{a.pen}mm</small>
            </div>
          ))}
        </div>
        <div className="reload">
          <div><i style={{ width: `${h.reloadFrac * 100}%` }} className={h.reloadFrac >= 1 ? 'ready' : ''} /></div>
          <span>{h.reloadFrac >= 1 ? 'READY' : `${h.reloadLeft.toFixed(1)} s`}{h.clipSize ? ` · clip ${h.clip}/${h.clipSize}` : ''} · {h.rounds} rds</span>
        </div>
        <div className="service">
          <span className={h.fire ? 'alert' : ''}><kbd>F</kbd> Extinguisher ×{h.extinguishers}{h.extFrac > 0 ? ` ${pct(h.extFrac)}%` : ''}</span>
          <span className={!h.medkitsAllowed ? 'off' : ''}><kbd>H</kbd> First aid ×{h.medkitsAllowed ? h.medkits : '—'}</span>
          <span><kbd>R</kbd> Repair{h.repairFrac > 0 ? ` ${pct(h.repairFrac)}%` : ''}</span>
          {h.baseFrac > 0 && <span className="good">Crew replacement {pct(h.baseFrac)}%</span>}
        </div>
      </div>
      <div className="crewpanel panel">
        <div className="ptitle">CREW <small>structure {pct(h.structure)}%</small></div>
        {h.crew.map((c) => (
          <div key={c.seat} className={`crewrow ${c.hp <= 0 ? 'kia' : ''}`}>
            <span className="roles">{c.roles.map((r) => ROLE_NAMES[r as Role]).join(' / ')}</span>
            <div className="hpbar"><i style={{ width: `${c.hp}%`, background: hpColor(c.hp / 100) }} /></div>
            <span className="st">{c.status}</span>
          </div>
        ))}
        <div className="effects">
          <span title="Aim & traverse speed">GUN {pct(eff.gunner)}%</span>
          <span title="Reload speed">LOAD {pct(eff.loader)}%</span>
          <span title="Steering & mobility">DRIVE {pct(eff.driver)}%</span>
          <span title="Spotting range">SPOT {pct(eff.commander)}%</span>
          <span title="Team info sharing">RADIO {pct(eff.radio)}%</span>
        </div>
        <div className="mods">
          {h.modules.filter((m) => m.type !== 'ammo' && m.type !== 'fuel').map((m) => (
            <span key={m.idx} className="mod" style={{ borderColor: hpColor(m.frac), color: m.frac <= 0 ? '#ff6a50' : undefined }}>{m.name.replace('Gun ', '')}</span>
          ))}
          {lay.modules.some((m) => m.type === 'ammo') && (
            <span className="mod" style={{ borderColor: hpColor(Math.min(...h.modules.filter((m) => m.type === 'ammo').map((m) => m.frac))) }}>Ammo</span>
          )}
        </div>
        <div className="hint"><kbd>I</kbd> interior damage panel</div>
      </div>
    </>
  );
}

function reportDetails(rep: HitReport) {
  return (
    <>
      <div className={`result ${RESULT_CLASS[rep.result]}`}>{RESULT_LABEL[rep.result]}{rep.ammoDetonation ? ' · AMMO DETONATION' : ''}{rep.fire ? ' · FIRE' : ''}</div>
      <div className="kv">
        <span>Section</span><b>{rep.section}</b>
        {rep.thickness > 0 && <><span>Armor</span><b>{rep.thickness} mm @ {rep.angle}° → {rep.effective} mm eff.</b></>}
        {rep.pen > 0 && <><span>Projectile</span><b>{rep.ammoName} · {rep.pen} mm pen · {rep.distance} m</b></>}
        <span>Severity</span><b className={`sev-${rep.severity}`}>{rep.severity.toUpperCase()}{rep.structureDmg ? ` (−${rep.structureDmg} structure)` : ''}</b>
      </div>
      {rep.modulesHit.length > 0 && <div className="list">{rep.modulesHit.map((m, i) => <span key={i} className={m.state}>{m.name}: {m.state}{m.type === 'ammo' ? ' ⚠' : ''}</span>)}</div>}
      {rep.crewHit.length > 0 && <div className="list">{rep.crewHit.map((c, i) => <span key={i} className={c.hpAfter <= 0 ? 'destroyed' : 'damaged'}>{c.roles.map((r) => ROLE_NAMES[r]).join('/')}: {c.status}{c.hpAfter > 0 ? ` ${c.hpAfter}%` : ''}</span>)}</div>}
    </>
  );
}

function HitCard({ rep, spec, crew, modules, title, compact }: { rep: HitReport; spec: TankSpec; crew: number[]; modules: number[]; title: string; compact?: boolean }) {
  return (
    <div className="hitcard">
      <div className="ptitle">{title} <small>{rep.shooterName}</small></div>
      <div className="cuts">
        <Cutaway spec={spec} crew={crew} modules={modules} turretYaw={rep.turretYaw} report={rep} view="side" width={compact ? 250 : 320} height={compact ? 96 : 120} />
        <Cutaway spec={spec} crew={crew} modules={modules} turretYaw={rep.turretYaw} report={rep} view="top" width={compact ? 250 : 320} height={compact ? 104 : 130} />
      </div>
      {reportDetails(rep)}
    </div>
  );
}

function OutgoingCam({ game, rep }: { game: Game; rep: HitReport }) {
  const v = game.vehicles.get(rep.target) as Tank | undefined;
  const spec = getVehicle(rep.vehicleId);
  if (spec.kind !== 'tank') return null;
  const crew = v && v.kind === 'tank' ? v.dmg.crew : spec.crew.map(() => 100);
  const lay = getLayout(spec);
  const mods = v && v.kind === 'tank' ? v.dmg.modules : lay.modules.map((m) => m.maxHp);
  return (
    <div className="hitcam panel">
      <HitCard rep={rep} spec={spec} crew={crew} modules={mods} title={`HIT CAMERA · ${rep.targetName} (${spec.name})`} compact />
    </div>
  );
}

function InteriorPanel({ game, h, spec, tank, onClose }: { game: Game; h: ReturnType<HudStore['get']>; spec: TankSpec; tank: Tank; onClose: () => void }) {
  const [sel, setSel] = useState<number>(-1);
  const [hl, setHl] = useState<number | null>(null);
  const [, force] = useState(0);
  useEffect(() => { const i = setInterval(() => force((x) => x + 1), 250); return () => clearInterval(i); }, []);
  useEffect(() => { game.input.exitLock(); }, [game]);
  const lay = getLayout(spec);
  const rep = sel >= 0 ? h.incoming[sel] : null;
  const crew = tank.dmg.crew, mods = tank.dmg.modules;
  return (
    <div className="modal interior" onClick={onClose}>
      <div className="panel big" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <h2>INTERIOR DAMAGE INSPECTION</h2>
          <span>{spec.name} · {spec.crew.length} crew · structure {Math.round(h.structure * 100)}%{tank.dmg.fire > 0 ? ' · 🔥 ON FIRE' : ''}</span>
          <button className="btn small ghost" onClick={onClose}>Close [I]</button>
        </div>
        <div className="intgrid">
          <div className="cutcol">
            <Cutaway spec={spec} crew={crew} modules={mods} turretYaw={rep ? rep.turretYaw : tank.turretYaw} report={rep} view="side" width={560} height={190} labels highlight={hl} />
            <Cutaway spec={spec} crew={crew} modules={mods} turretYaw={rep ? rep.turretYaw : tank.turretYaw} report={rep} view="top" width={560} height={230} labels highlight={hl} />
            {rep ? <div className="repdetail">{reportDetails(rep)}</div> : <p className="dim">Select a hit from the log to trace the projectile path and spall through the vehicle.</p>}
          </div>
          <div className="sidecol">
            <h4>Crew</h4>
            {lay.seats.map((s) => (
              <div key={s.idx} className={`crewrow ${crew[s.idx] <= 0 ? 'kia' : ''}`}>
                <span className="roles">{s.roles.map((r) => ROLE_NAMES[r]).join(' / ')}<small>{s.inTurret ? 'turret' : 'hull'} · {s.seat} seat</small></span>
                <div className="hpbar"><i style={{ width: `${crew[s.idx]}%`, background: hpColor(crew[s.idx] / 100) }} /></div>
                <span className="st">{crewStatusLabel(crew[s.idx])} {Math.round(crew[s.idx])}%</span>
              </div>
            ))}
            <div className="effects wide">
              <span>Gunner → aim/traverse {Math.round(h.effects.gunner * 100)}%</span>
              <span>Loader → reload {Math.round(h.effects.loader * 100)}%</span>
              <span>Driver → steering {Math.round(h.effects.driver * 100)}%</span>
              <span>Commander → spotting {Math.round(h.effects.commander * 100)}%</span>
              <span>Radio → comms {Math.round(h.effects.radio * 100)}%</span>
            </div>
            <h4>Components</h4>
            <div className="modlist">
              {lay.modules.map((m) => (
                <div key={m.idx} className="modrow" onMouseEnter={() => setHl(m.idx)} onMouseLeave={() => setHl(null)}>
                  <span>{m.name}{m.inTurret ? ' (turret)' : ''}</span>
                  <div className="hpbar"><i style={{ width: `${(mods[m.idx] / m.maxHp) * 100}%`, background: hpColor(mods[m.idx] / m.maxHp) }} /></div>
                  <small>{mods[m.idx] <= 0 ? 'DESTROYED' : `${Math.round((mods[m.idx] / m.maxHp) * 100)}%`}{m.rounds !== undefined ? ` · ${Math.max(0, Math.round(tank.dmg.rounds[m.idx]))} rds` : ''}</small>
                </div>
              ))}
            </div>
            <h4>Hit log <small>({h.incoming.length})</small></h4>
            <div className="hitlog">
              {h.incoming.length === 0 && <p className="dim">No hits taken yet.</p>}
              {h.incoming.map((r, i) => (
                <button key={i} className={`logrow ${sel === i ? 'sel' : ''}`} onClick={() => setSel(sel === i ? -1 : i)}>
                  <b className={RESULT_CLASS[r.result]}>{RESULT_LABEL[r.result]}</b>
                  <span>{r.section} · {r.ammoName}</span>
                  <small>{r.shooterName} · {r.distance} m · {r.severity}</small>
                </button>
              ))}
            </div>
            <p className="dim small">Rules: first-aid kits {game.rules.medkits ? 'enabled' : 'disabled'} · crew replacement at base {game.rules.crewReplacement ? 'enabled (stop in your spawn zone)' : 'disabled'}.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Scoreboard({ h }: { h: ReturnType<HudStore['get']> }) {
  return (
    <div className="modal scoreboard">
      <div className="panel big">
        <div className="sbcols">
          {[0, 1].map((team) => (
            <div key={team}>
              <h3 className={`t${team}`}>{TEAM_NAMES[team]} <b>{h.tickets[team]}</b></h3>
              <table>
                <thead><tr><th>Player</th><th>Vehicle</th><th>K</th><th>D</th><th>Caps</th><th>Score</th></tr></thead>
                <tbody>
                  {h.scoreboard.filter((r) => r.team === team).sort((a, b) => b.score - a.score).map((r) => (
                    <tr key={r.id} className={`${r.isMe ? 'me' : ''} ${r.alive ? '' : 'dead'}`}>
                      <td>{r.name}</td><td>{r.vehicle}</td><td>{r.kills}</td><td>{r.deaths}</td><td>{r.caps}</td><td>{r.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Respawn({ game, h }: { game: Game; h: ReturnType<HudStore['get']> }) {
  const team = h.myTeam as 0 | 1;
  const list = allowedVehicles(team, game.session.start?.settings ?? game.session.lobby.settings);
  const [sel, setSel] = useState(h.myVehicleId);
  useEffect(() => { game.input.exitLock(); }, [game]);
  return (
    <div className="modal respawn">
      <div className="panel big">
        <h2>VEHICLE DESTROYED</h2>
        <p>{h.killedBy ? `Knocked out by ${h.killedBy}` : ''}</p>
        <div className="vgrid small">
          {list.map((v) => (
            <button key={v.id} className={`vcard ${sel === v.id ? 'sel' : ''}`} onClick={() => setSel(v.id)}>
              <b>{v.name}</b><small>{CLASS_LABEL[v.cls]} · {v.nation}</small>
            </button>
          ))}
        </div>
        <button className="btn primary" disabled={h.respawnIn > 0} onClick={() => { if (game.respawn(sel)) game.input.requestLock(); }}>
          {h.respawnIn > 0 ? `Redeploy in ${h.respawnIn}s` : 'DEPLOY'}
        </button>
      </div>
    </div>
  );
}

function EndScreen({ h, onLeave }: { h: ReturnType<HudStore['get']>; onLeave: () => void }) {
  const win = h.winner === h.myTeam;
  return (
    <div className="modal end">
      <div className="panel big">
        <h1 className={h.winner === -1 ? '' : win ? 'win' : 'lose'}>{h.winner === -1 ? 'DRAW' : win ? 'VICTORY' : 'DEFEAT'}</h1>
        <p>{h.winner >= 0 ? `${TEAM_NAMES[h.winner]} win — ` : ''}{h.endReason}</p>
        <Scoreboard h={h} />
        <button className="btn primary" onClick={onLeave}>Return to lobby</button>
      </div>
    </div>
  );
}

export function Controls({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="panel big controls" onClick={(e) => e.stopPropagation()}>
        <h2>CONTROLS</h2>
        <div className="ccols">
          <div>
            <h4>Tanks</h4>
            <ul>
              <li><kbd>W</kbd><kbd>S</kbd> throttle · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Space</kbd> brake</li>
              <li><kbd>Mouse</kbd> aim turret · <kbd>LMB</kbd> fire</li>
              <li><kbd>RMB</kbd>/<kbd>Shift</kbd> gunner sight · <kbd>Wheel</kbd> zoom</li>
              <li><kbd>V</kbd> driver view · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> ammunition</li>
              <li><kbd>R</kbd> repair · <kbd>F</kbd> extinguish · <kbd>H</kbd> first aid</li>
              <li><kbd>I</kbd> interior damage panel</li>
              <li>AI orders: <kbd>Z</kbd> attack target · <kbd>X</kbd> follow me · <kbd>C</kbd> capture point</li>
            </ul>
          </div>
          <div>
            <h4>Aircraft</h4>
            <ul>
              <li><kbd>Mouse</kbd> steer (mouse-aim) · <kbd>LMB</kbd> guns</li>
              <li><kbd>W</kbd><kbd>S</kbd> throttle · <kbd>A</kbd><kbd>D</kbd> roll · <kbd>Q</kbd><kbd>E</kbd> rudder</li>
              <li><kbd>↑</kbd><kbd>↓</kbd> pitch override</li>
              <li><kbd>Space</kbd> drop bomb · <kbd>RMB</kbd>/<kbd>R</kbd> rockets</li>
              <li><kbd>V</kbd> cockpit view · <kbd>Wheel</kbd> camera distance</li>
            </ul>
            <h4>General</h4>
            <ul><li>Hold <kbd>Tab</kbd> scoreboard · <kbd>F1</kbd> this help · <kbd>Esc</kbd> free cursor</li></ul>
          </div>
        </div>
        <p className="dim">Reticle colour shows whether your loaded round can penetrate the armor under the crosshair: green = likely, yellow = borderline, red = unlikely.</p>
      </div>
    </div>
  );
}
