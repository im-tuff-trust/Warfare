import type { NextRequest } from 'next/server';

/** Check whether a room code exists on the realtime server. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const ws = process.env.REALTIME_URL || process.env.NEXT_PUBLIC_REALTIME_URL;
  const base = process.env.REALTIME_HTTP_URL || (ws ? ws.replace(/^ws(s?):\/\//, 'http$1://') : null);
  if (!base) return Response.json({ code: clean, exists: null });
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/rooms/' + clean, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { exists?: boolean; players?: number };
    return Response.json({ code: clean, exists: !!j.exists, players: j.players ?? 0 });
  } catch {
    return Response.json({ code: clean, exists: null });
  }
}
