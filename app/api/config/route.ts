// Tells the browser which persistent realtime server (WebSocket relay) to use.
// Vercel functions are stateless, so live game traffic goes to server/realtime.mjs
// deployed on a host that supports long-lived connections (Render, Fly.io, Railway…).
export async function GET() {
  const realtimeUrl = process.env.REALTIME_URL || process.env.NEXT_PUBLIC_REALTIME_URL || null;
  return Response.json({ realtimeUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
