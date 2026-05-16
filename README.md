# Glowbound Grove

Glowbound Grove is a mobile-first social multiplayer web game built with Node, Express, Socket.IO, and a responsive HTML5 canvas client.

Players enter a shared glowing garden, collect drifting glowseeds, deposit them at the central grove, level up, earn coins, and interact with nearby players using quick social actions and emotes. It is designed for phones first: full-screen layout, touch joystick, thumb-safe action buttons, installable PWA metadata, and no keyboard-dependent gameplay.

## Features

- Real-time multiplayer using Socket.IO
- Mobile touch joystick movement
- Shared cooperative objective: grow the central grove
- Player progression: XP, levels, coins, carried seeds, total deposits
- Social interaction: wave, cheer, dance, and spark with nearby players
- No free-text chat by default, reducing moderation overhead for public demos
- Persistent player profiles saved server-side to `data/players.json`
- Browser identity saved in `localStorage`
- PWA manifest and service worker for app-like installation
- Single-room prototype that can be extended into parties, zones, events, or guild gardens

## Game loop

1. Move around the grove with the virtual joystick.
2. Collect small glowing seeds by walking over them.
3. Deposit carried seeds at the central grove circle.
4. Earn XP and coins.
5. Approach another player and tap **Spark** to give both players friendship XP.
6. Use emotes to communicate quickly.

## Install

```bash
npm install
```

## Run locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

For phone testing on the same Wi-Fi network, find your computer's local IP address and open:

```text
http://YOUR_LOCAL_IP:3000
```

## Production run

```bash
npm start
```

## Deployment notes

This project uses WebSockets, so deploy it to a host that supports long-running Node servers and WebSocket upgrades, such as Render, Railway, Fly.io, DigitalOcean, or a VPS.

Vercel's standard serverless functions are not ideal for this exact all-in-one Socket.IO server. A common production pattern is to deploy the static client separately and host the Socket.IO server on a persistent Node runtime.

## Project structure

```text
glowbound-grove/
├── server.js
├── package.json
├── README.md
├── data/
│   └── players.json      # created automatically at runtime
└── public/
    ├── index.html
    ├── styles.css
    ├── client.js
    ├── manifest.json
    └── sw.js
```

## Tuning constants

Most gameplay values can be adjusted in `server.js`:

- `WORLD.width` / `WORLD.height`
- `MAX_SEEDS`
- `PLAYER_SPEED`
- `COLLECT_RADIUS`
- `DEPOSIT_RADIUS`
- XP values in `collectSeed`, `depositSeeds`, and `socialSpark`

## Suggested next upgrades

- Add named private groves/party rooms
- Add timed community events
- Add unlockable trails, shells, outfits, or pets
- Add Firebase/Supabase authentication and database storage
- Add moderation tools if free-text chat is introduced
- Add seasonal map skins and collectible sets
