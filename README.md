# WARFARE: Steel & Sky

A browser-based 3D multiplayer WWII tank and aircraft combat game built with **Three.js** and **Next.js 16**. Nothing to download.

- **Tanks**: Light (M5A1 Stuart, T-70, Pz.II Luchs), Medium (Panzer IV H, T-34, M4A1 Sherman), Heavy (Tiger I, KV-1, M26 Pershing)
- **Aircraft**: Fighters (Bf 109 G-6, Yak-9, P-51D) and bombers/attackers (Ju 87 Stuka, Il-2, B-25J)
- **Battlefields**: Normandy (Saint-Lô bocage), Stalingrad (ruined city, Red October factory, Mamayev Kurgan), Kursk (Prokhorovka, Hill 252.2), North Africa (Kasserine Pass). Terrain, villages, roads, hedgerows and forests are generated from a shared seed. Buildings, hedges, walls and trees can be destroyed.

## Gameplay systems

- **Armor and ballistics.** Hulls and turrets are convex volumes built from each vehicle's real plate thicknesses and slopes. The same geometry is used for rendering and for hit detection, so the impact angle comes from the actual surface hit. Each shot goes through normalization, overmatch, ricochet, penetration falloff with distance, and differences between APHE, AP, APCR and HE rounds.
- **Crew.** Every tank has the Commander, Driver, Gunner, Loader and Radio Operator roles, with seat positions specific to each vehicle. On smaller crews one person covers several roles: on the T-34 the commander is also the gunner, and on the T-70 the commander does almost everything. Injuries affect gameplay:
  - a wounded gunner traverses and aims more slowly, and shots spread more
  - a wounded loader makes reloads longer
  - a wounded driver makes steering and acceleration less responsive
  - a wounded commander reduces spotting range
  - a wounded radio operator limits team spotting data and stops AI orders getting through

  If a crewman is killed, another crew member takes over the job at reduced efficiency.
- **Internal damage.** After a penetration, shell and spall rays are traced through the crew and the components: engine, transmission, ammo racks, fuel tanks, breech, turret drive, radio, tracks and barrel. The results can include fires, ammo cook-off or detonation (which throws the turret off), broken tracks and knocked-out crew.
- **Damage visualization.** Every incoming hit pops up a side and top cutaway. It shows where the round hit outside, the internal shell and spall paths, the result (ricochet, non-penetration, partial penetration, penetration, or component hit), the armor section, its thickness, angle and effective thickness, the severity, and which components and crew were hit. Your own hits show the same cutaway for the target (the hit camera). Press **I** to open the interior damage inspection panel, which keeps a log of every hit you've taken and can replay each one.
- **Recovery** (both rules can be toggled by the host):
  - first-aid kits (**H**) heal wounded crew
  - stopping in your base zone replaces dead crew and repairs the vehicle

  The crew can also repair in the field (**R**) and put out fires (**F**).
- **Matches.** Domination on 3 capture points with a ticket bleed, a time limit, respawning with free vehicle choice, a scoreboard, a kill feed and a minimap with team spotting.
- **AI.** Tank bots:
  - pick objectives and spread out between them
  - steer around obstacles and recover when stuck
  - angle their armor and lead moving targets
  - compensate for shell drop
  - choose ammunition based on the target's armor
  - repair, put out fires, use first aid, and retreat for crew replacement
  - follow player orders: **Z** attack my target, **X** follow me, **C** capture this point

  Fighters dogfight and strafe. Bombers dive-bomb, level-bomb, or make rocket and cannon runs. Bombers have automatic rear gunners.
- **Views.** Third-person, gunner sight with zoom (right mouse / Shift), driver view (**V**). Aircraft have a chase camera and a cockpit view (**V**).
- **Audio and effects.** All sounds are synthesized live with WebAudio: engines, guns (which reach you at the speed of sound), explosions, ricochets and the Stuka siren. The visual effects include particle smoke and fire, debris, scorch marks and tracers.

Press **F1** in game for the full list of controls.

## Multiplayer architecture

```
Browser (Next.js + Three.js) ──HTTP──▶ Vercel: /api/rooms (create code), /api/rooms/[code], /api/config
          │
          └──────WebSocket──────▶ server/realtime.mjs (persistent relay: rooms, peers, host election)
```

- Click **PLAY** and the game asks `/api/rooms` for a unique 6-character room code, reserved on the relay. Share the code or the invite link. Other players can type the code in to join.
- The host (the earliest player still in the room) is authoritative for the lobby, capture points, tickets, scores and the AI bots. Each client simulates its own vehicle and sends snapshots 12 times a second.
- The client that fired a shot detects the hit. The owner of the vehicle that was hit works out the damage and broadcasts the hit report. If the host leaves, the next player takes over as host and adopts the bots.
- If nobody joins before the lobby countdown runs out (30 s by default), AI fills the empty slots on both teams.
- Vercel functions can't hold WebSockets open, so the relay is a separate small Node service.

## Running locally

```bash
npm install
npm run dev            # http://localhost:3000
```

If `REALTIME_URL` isn't set, the game runs in **local mode**: rooms work between browser tabs on the same device (via BroadcastChannel). To test real network play:

```bash
PORT=8787 npm run realtime            # terminal 1
REALTIME_URL=ws://localhost:8787 npm run dev   # terminal 2
```

## Deploying

1. **Realtime relay.** Deploy `server/` to any host that supports long-lived connections:
   - Render, using the `render.yaml` blueprint
   - Fly.io or Railway, using `server/Dockerfile`
   - any VPS, with `node server/realtime.mjs`

   Optionally set `ALLOWED_ORIGINS=https://your-app.vercel.app`.
2. **Frontend and API.** Import the repo into Vercel and set the environment variable `REALTIME_URL=wss://<your-relay-host>`.

## Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js layout, page, and the API route handlers for room codes and config |
| `src/game/data/` | Vehicle and ammunition specs, map definitions |
| `src/game/sim/` | Armor geometry, crew and component layout, the penetration and damage model |
| `src/game/world/` | Seeded map generation, terrain, collision, destruction |
| `src/game/render/` | Procedural vehicle models, props, particles, HUD overlay and minimap |
| `src/game/entities.ts` | Tank and aircraft simulation |
| `src/game/ai.ts` | Tank and aircraft AI and the team blackboard |
| `src/game/game.ts` | Game loop, cameras, projectiles, networking, rules |
| `src/game/net/` | Transports (WebSocket and BroadcastChannel), lobby session |
| `src/game/ui/` | React menu, lobby, HUD, cutaway renderer |
| `server/realtime.mjs` | WebSocket relay |
