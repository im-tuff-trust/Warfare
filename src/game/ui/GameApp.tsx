'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Session, type StartInfo } from '../net/session';
import { normalizeCode } from '../net/transport';
import { Game, type Quality } from '../game';
import { HudStore } from '../hud';
import { audio } from '../audio';
import { MAPS } from '../data/maps';
import Lobby from './Lobby';
import Hud, { Controls } from './Hud';

interface Prefs { name: string; quality: Quality; sensitivity: number; volume: number; }

const DEFAULT_PREFS: Prefs = { name: '', quality: 'medium', sensitivity: 1, volume: 0.7 };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem('warfare.prefs');
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_PREFS, name: 'Tanker' + Math.floor(100 + Math.random() * 900) };
}

function savePrefs(p: Prefs) { try { localStorage.setItem('warfare.prefs', JSON.stringify(p)); } catch { /* ignore */ } }

type Phase = 'menu' | 'connecting' | 'lobby' | 'game';

export default function GameApp() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [phase, setPhase] = useState<Phase>('menu');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [help, setHelp] = useState(false);
  const [game, setGame] = useState<Game | null>(null);
  const [store, setStore] = useState<HudStore | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);

  useEffect(() => {
    setPrefs(loadPrefs());
    const q = new URLSearchParams(window.location.search).get('room');
    if (q) setJoinCode(normalizeCode(q));
  }, []);
  const update = (p: Partial<Prefs>) => setPrefs((old) => { const n = { ...old, ...p }; savePrefs(n); return n; });

  const startGame = useCallback((s: Session, info: StartInfo) => {
    if (gameRef.current) { gameRef.current.dispose(); gameRef.current = null; }
    setPhase('game');
    // wait for the container to mount
    requestAnimationFrame(() => {
      if (!container.current) return;
      const hs = new HudStore();
      try {
        const g = new Game(container.current, s, info, hs, { quality: prefs.quality, sensitivity: prefs.sensitivity, volume: prefs.volume });
        gameRef.current = g;
        setGame(g); setStore(hs);
      } catch (e) {
        console.error(e);
        setError('Could not start the 3D engine: ' + (e as Error).message + ' — WebGL may be unavailable.');
        setPhase('lobby');
      }
    });
  }, [prefs]);

  const attach = useCallback((s: Session) => {
    s.onStart = (info) => startGame(s, info);
    setSession(s);
    setPhase('lobby');
    const url = new URL(window.location.href);
    url.searchParams.set('room', s.code);
    window.history.replaceState(null, '', url.toString());
  }, [startGame]);

  const play = async () => {
    audio.init();
    setError(''); setPhase('connecting');
    try { attach(await Session.create(prefs.name.trim() || 'Tanker')); }
    catch (e) { setError((e as Error).message); setPhase('menu'); }
  };
  const join = async () => {
    audio.init();
    setError(''); setPhase('connecting');
    try { attach(await Session.join(joinCode, prefs.name.trim() || 'Tanker')); }
    catch (e) { setError((e as Error).message); setPhase('menu'); }
  };

  const leaveGame = () => {
    gameRef.current?.dispose();
    gameRef.current = null;
    setGame(null); setStore(null);
    if (session) { session.backToLobby(); setPhase('lobby'); }
    else setPhase('menu');
  };
  const leaveLobby = () => {
    session?.leave();
    setSession(null);
    setPhase('menu');
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url.toString());
  };

  useEffect(() => () => { gameRef.current?.dispose(); }, []);

  return (
    <div className="app">
      {phase === 'menu' || phase === 'connecting' ? (
        <div className="menu">
          <div className="menubg" />
          <div className="menucontent">
            <div className="brand">
              <div className="eyebrow">1939 — 1945</div>
              <h1>WARFARE</h1>
              <div className="sub">Steel &amp; Sky</div>
            </div>
            <button className="playbtn" onClick={play} disabled={phase === 'connecting'}>{phase === 'connecting' ? 'CONNECTING…' : 'PLAY'}</button>
            <div className="menuhint">Creates a new lobby with a shareable room code. AI fills empty slots if nobody joins.</div>
            <div className="joinrow">
              <input placeholder="ROOM CODE" value={joinCode} maxLength={6} onChange={(e) => setJoinCode(normalizeCode(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter' && joinCode.length === 6) join(); }} />
              <button className="btn" disabled={joinCode.length !== 6 || phase === 'connecting'} onClick={join}>JOIN</button>
            </div>
            {error && <div className="error">{error}</div>}
            <div className="prefs panel">
              <label>Callsign<input value={prefs.name} maxLength={18} onChange={(e) => update({ name: e.target.value })} /></label>
              <label>Graphics<select value={prefs.quality} onChange={(e) => update({ quality: e.target.value as Quality })}><option value="low">Low (fast)</option><option value="medium">Medium</option><option value="high">High</option></select></label>
              <label>Mouse {prefs.sensitivity.toFixed(1)}×<input type="range" min={0.3} max={2.5} step={0.1} value={prefs.sensitivity} onChange={(e) => update({ sensitivity: +e.target.value })} /></label>
              <label>Volume {Math.round(prefs.volume * 100)}%<input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => update({ volume: +e.target.value })} /></label>
              <button className="btn ghost small" onClick={() => setHelp(true)}>Controls</button>
            </div>
            <div className="mapstrip">
              {MAPS.map((m) => <div key={m.id} className={`mapcard m-${m.id}`}><b>{m.name}</b><small>{m.location} · {m.date}</small></div>)}
            </div>
            <div className="foot">Panzer IV · Tiger I · T-34 · KV-1 · M4 Sherman · M26 Pershing · Stuart · T-70 · Luchs · Bf 109 · Yak-9 · P-51D · Ju 87 · Il-2 · B-25J</div>
          </div>
          {help && <Controls onClose={() => setHelp(false)} />}
        </div>
      ) : null}
      {phase === 'lobby' && session && (
        <>
          <Lobby session={session} onLeave={leaveLobby} />
          {error && <div className="error floating" onClick={() => setError('')}>{error}</div>}
        </>
      )}
      {phase === 'game' && (
        <div className="gamewrap">
          <div ref={container} className="viewport" />
          {game && store && <Hud game={game} store={store} onLeave={leaveGame} />}
          {!game && <div className="boot">Generating battlefield…</div>}
        </div>
      )}
    </div>
  );
}
