'use client';
import dynamic from 'next/dynamic';

// The game touches WebGL, WebAudio and BroadcastChannel, so it renders on the client only.
const GameApp = dynamic(() => import('@/game/ui/GameApp'), {
  ssr: false,
  loading: () => <div className="boot">Loading WARFARE…</div>,
});

export default function GameRoot() {
  return <GameApp />;
}
