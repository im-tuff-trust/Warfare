import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function code(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

function httpBase(): string | null {
  const ws = process.env.REALTIME_URL || process.env.NEXT_PUBLIC_REALTIME_URL;
  if (process.env.REALTIME_HTTP_URL) return process.env.REALTIME_HTTP_URL.replace(/\/$/, '');
  if (!ws) return null;
  return ws.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
}

/** Create a lobby: reserve a unique room code on the realtime server when one is configured. */
export async function POST() {
  const base = httpBase();
  if (base) {
    try {
      const r = await fetch(base + '/rooms', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = (await r.json()) as { code?: string };
        if (j.code) return Response.json({ code: j.code, reserved: true });
      }
    } catch {
      // fall through to a locally generated code
    }
  }
  return Response.json({ code: code(), reserved: false });
}
