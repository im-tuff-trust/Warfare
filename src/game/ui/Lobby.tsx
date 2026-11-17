'use client';
import { useState, useSyncExternalStore } from 'react';
import { MAPS } from '../data/maps';
import { CLASS_LABEL, NATION_NAMES, ROLE_NAMES, getVehicle, type AircraftSpec, type TankSpec, type VehicleClass, type VehicleSpec } from '../data/vehicles';
import { AMMO } from '../data/ammo';
import { allowedVehicles, buildRoster, TEAM_NAMES, type Difficulty, type Session } from '../net/session';

const CLASSES: VehicleClass[] = ['light', 'medium', 'heavy', 'fighter', 'bomber'];

export default function Lobby({ session, onLeave }: { session: Session; onLeave: () => void }) {
  useSyncExternalStore((l) => session.subscribe(l), () => session.version, () => session.version);
  const lobby = session.lobby;
  const s = lobby.settings;
  const me = lobby.players.find((p) => p.id === session.myId);
  const myTeam = (me?.team ?? 0) as 0 | 1;
  const list = allowedVehicles(myTeam, s);
  const current = me ? getVehicle(me.vehicleId) : list[0];
  const [cls, setCls] = useState<VehicleClass>(current.cls);
  const [copied, setCopied] = useState('');
  const host = session.isHost;
  const remaining = session.remaining();
  const preview = buildRoster(lobby.players, s, () => 0.5);
  const link = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}?room=${lobby.code}` : '';
  const map = MAPS.find((m) => m.id === s.map)!;

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500); } catch { setCopied('copy failed'); }
  };

  return (
    <div className="lobby">
      <header className="lobbyhead">
        <div>
          <div className="eyebrow">Lobby · {host ? 'you are the host' : 'waiting for host'}</div>
          <div className="code" onClick={() => copy(lobby.code, 'code')} title="Copy room code">
            {lobby.code.split('').map((ch, i) => <span key={i}>{ch}</span>)}
          </div>
          <div className="share">
            <button className="btn small" onClick={() => copy(lobby.code, 'code')}>{copied === 'code' ? 'Copied!' : 'Copy code'}</button>
            <button className="btn small" onClick={() => copy(link, 'link')}>{copied === 'link' ? 'Copied!' : 'Copy invite link'}</button>
            {session.mode === 'local' && <span className="note">Local mode: no realtime server configured — friends can join from other tabs on this device. Set <code>REALTIME_URL</code> for internet play.</span>}
          </div>
        </div>
        <div className="countdown">
          <div className="big">{remaining}s</div>
          <div>{lobby.players.length > 1 ? 'Battle starts when everyone is ready, or in' : 'Waiting for players… AI will fill empty slots in'} {remaining}s</div>
          <div className="row">
            {host && <button className="btn primary" onClick={() => session.startNow()}>Start now</button>}
            {host && <button className="btn" onClick={() => session.extendWait(30)}>+30s</button>}
            <button className={`btn ${me?.ready ? 'good' : ''}`} onClick={() => session.setPref({ ready: !me?.ready })}>{me?.ready ? 'Ready ✓' : 'Ready'}</button>
            <button className="btn ghost" onClick={onLeave}>Leave</button>
          </div>
        </div>
      </header>

      <div className="lobbygrid">
        {/* -------- teams */}
        <section className="panel teams">
          {[0, 1].map((team) => (
            <div key={team} className={`teamcol t${team}`}>
              <h3>{TEAM_NAMES[team]} <small>{team === 1 ? NATION_NAMES.GER : s.historical ? NATION_NAMES[map.allies] : 'USA & USSR'}</small></h3>
              {preview.filter((r) => r.team === team).map((r) => {
                const v = getVehicle(r.vehicleId);
                const p = lobby.players.find((x) => x.id === r.id);
                return (
                  <div key={r.id} className={`slot ${r.isBot ? 'bot' : ''} ${r.id === session.myId ? 'me' : ''}`}>
                    <span>{r.isBot ? 'AI (auto-fill)' : r.name}{r.id === lobby.hostId ? ' ★' : ''}</span>
                    <small>{r.isBot ? CLASS_LABEL[v.cls] : `${v.name}`}{p?.ready ? ' · ready' : ''}</small>
                  </div>
                );
              })}
              {me && myTeam !== team && <button className="btn small" onClick={() => session.setPref({ team: team as 0 | 1 })}>Join {TEAM_NAMES[team]}</button>}
            </div>
          ))}
        </section>

        {/* -------- vehicle selection */}
        <section className="panel vehicles">
          <div className="tabs">
            {CLASSES.filter((c) => list.some((v) => v.cls === c)).map((c) => (
              <button key={c} className={cls === c ? 'sel' : ''} onClick={() => setCls(c)}>{CLASS_LABEL[c]}</button>
            ))}
          </div>
          <div className="vgrid">
            {list.filter((v) => v.cls === cls).map((v) => (
              <button key={v.id} className={`vcard ${me?.vehicleId === v.id ? 'sel' : ''}`} onClick={() => session.setPref({ vehicleId: v.id })}>
                <b>{v.name}</b>
                <small>{NATION_NAMES[v.nation]} · {v.year}</small>
              </button>
            ))}
          </div>
          {current && <VehicleCard v={current} />}
        </section>

        {/* -------- match settings */}
        <section className="panel settings">
          <h3>Battlefield</h3>
          <div className="maps">
            {MAPS.map((m) => (
              <button key={m.id} disabled={!host} className={`mapcard m-${m.id} ${s.map === m.id ? 'sel' : ''}`} onClick={() => session.setSettings({ map: m.id })}>
                <b>{m.name}</b><small>{m.location}<br />{m.date}</small>
              </button>
            ))}
          </div>
          <p className="dim">{map.blurb}</p>
          <h3>Rules {host ? '' : <small>(host only)</small>}</h3>
          <div className="form">
            <label>Tickets<select disabled={!host} value={s.tickets} onChange={(e) => session.setSettings({ tickets: +e.target.value })}>{[200, 300, 400, 600, 800].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label>Players per team<select disabled={!host} value={s.teamSize} onChange={(e) => session.setSettings({ teamSize: +e.target.value })}>{[2, 3, 4, 5, 6, 8].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label>AI skill<select disabled={!host} value={s.difficulty} onChange={(e) => session.setSettings({ difficulty: e.target.value as Difficulty })}><option value="easy">Recruit</option><option value="normal">Veteran</option><option value="hard">Ace</option></select></label>
            <label>Time limit<select disabled={!host} value={s.timeLimit} onChange={(e) => session.setSettings({ timeLimit: +e.target.value })}>{[10, 15, 20, 30].map((x) => <option key={x} value={x}>{x} min</option>)}</select></label>
            <label>Auto-fill wait<select disabled={!host} value={s.waitSeconds} onChange={(e) => session.setSettings({ waitSeconds: +e.target.value })}>{[15, 30, 60, 120].map((x) => <option key={x} value={x}>{x} s</option>)}</select></label>
            <label className="chk"><input type="checkbox" disabled={!host} checked={s.medkits} onChange={(e) => session.setSettings({ medkits: e.target.checked })} />First-aid kits heal wounded crew</label>
            <label className="chk"><input type="checkbox" disabled={!host} checked={s.crewReplacement} onChange={(e) => session.setSettings({ crewReplacement: e.target.checked })} />Crew replacement &amp; repair at base</label>
            <label className="chk"><input type="checkbox" disabled={!host} checked={s.aircraft} onChange={(e) => session.setSettings({ aircraft: e.target.checked })} />Aircraft enabled</label>
            <label className="chk"><input type="checkbox" disabled={!host} checked={s.historical} onChange={(e) => session.setSettings({ historical: e.target.checked })} />Historical match-ups (map decides Allied nation)</label>
          </div>
        </section>
      </div>
    </div>
  );
}

function VehicleCard({ v }: { v: VehicleSpec }) {
  if (v.kind === 'tank') {
    const t = v as TankSpec;
    const a = t.armor;
    return (
      <div className="vdetail">
        <h4>{t.name} <small>{CLASS_LABEL[t.cls]} · {NATION_NAMES[t.nation]} · {t.year}</small></h4>
        <p>{t.blurb}</p>
        <div className="stats">
          <span>Gun<b>{t.gun.name}</b></span>
          <span>Reload<b>{t.gun.reload.toFixed(1)} s{t.gun.clip ? ` (${t.gun.clip.size}-rd clip)` : ''}</b></span>
          <span>Top speed<b>{t.maxSpeed} km/h</b></span>
          <span>Mass / power<b>{t.mass} t · {t.power} hp</b></span>
          <span>Hull armor<b>{a.upperFront}@{t.hull.aUp}° / {a.side} / {a.rear} mm</b></span>
          <span>Turret armor<b>{a.turretFront} / {a.turretSide} / {a.turretRear} mm</b></span>
          <span>Traverse<b>{t.turretTraverse}°/s turret · {t.hullTraverse}°/s hull</b></span>
          <span>Fuel<b>{t.layout.diesel ? 'Diesel' : 'Gasoline'}</b></span>
        </div>
        <div className="ammolist">{t.gun.ammo.map((id) => <span key={id}>{AMMO[id].name}: <b>{AMMO[id].pen100} mm</b></span>)}</div>
        <div className="crewlist">Crew: {t.crew.map((c, i) => <span key={i}>{c.roles.map((r) => ROLE_NAMES[r]).join(' + ')}</span>)}</div>
      </div>
    );
  }
  const p = v as AircraftSpec;
  return (
    <div className="vdetail">
      <h4>{p.name} <small>{CLASS_LABEL[p.cls]} · {NATION_NAMES[p.nation]} · {p.year}</small></h4>
      <p>{p.blurb}</p>
      <div className="stats">
        <span>Top speed<b>{p.maxSpeed} km/h</b></span>
        <span>Stall<b>{p.minSpeed} km/h</b></span>
        <span>Guns<b>{p.guns.map((g) => `${g.count}× ${AMMO[g.ammo].name}`).join(', ')}</b></span>
        <span>Ordnance<b>{p.bombs.map((b) => `${b.count}× ${AMMO[b.ammo].name}`).join(', ') || '—'}{p.rockets ? `, ${p.rockets.count}× ${AMMO[p.rockets.ammo].name}` : ''}</b></span>
        <span>Crew<b>{p.crewNames.join(', ')}</b></span>
        <span>Defensive gunner<b>{p.gunner ? 'Yes (automatic)' : 'No'}</b></span>
      </div>
    </div>
  );
}
