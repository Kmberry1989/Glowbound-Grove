const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;
const SNAPSHOT_RATE = 10;
const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

const WORLD = {
  width: 1400,
  height: 900,
  grove: { x: 700, y: 450, radius: 92 }
};

const MAX_SEEDS = 48;
const PLAYER_SPEED = 220;
const COLLECT_RADIUS = 32;
const DEPOSIT_RADIUS = 112;
const SOCIAL_RADIUS = 115;
const SPARK_COOLDOWN_MS = 12000;
const PROFILE_SAVE_MS = 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'players.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, players: players.size, seeds: seeds.size, grovePower });
});

const players = new Map();
const profiles = new Map();
const seeds = new Map();
const pulses = [];
let grovePower = 0;
let nextSeedId = 1;
let saveTimer = null;
let lastSnapshotAt = Date.now();

ensureDataFile();
loadProfiles();
seedInitialWorld();

io.on('connection', (socket) => {
  const handshake = normalizeHandshake(socket.handshake.auth || {});
  const profile = getOrCreateProfile(handshake.playerId, handshake.name, handshake.color);

  const spawn = randomSpawnNearGrove();
  const player = {
    id: socket.id,
    playerId: profile.playerId,
    name: profile.name,
    color: profile.color,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    faceX: 1,
    faceY: 0,
    inputX: 0,
    inputY: 0,
    carried: profile.carried || 0,
    xp: profile.xp || 0,
    level: levelFromXp(profile.xp || 0),
    coins: profile.coins || 0,
    totalDeposited: profile.totalDeposited || 0,
    joinedAt: Date.now(),
    lastSparkAt: profile.lastSparkAt || 0,
    emote: null,
    emoteUntil: 0,
    status: 'roaming'
  };

  players.set(socket.id, player);

  socket.emit('welcome', {
    socketId: socket.id,
    playerId: profile.playerId,
    world: WORLD,
    profile: serializeProfile(profile),
    serverTime: Date.now()
  });

  broadcastPulse({ type: 'join', x: player.x, y: player.y, text: `${player.name} arrived` });

  socket.on('input', (input) => {
    const p = players.get(socket.id);
    if (!p) return;

    const x = clamp(Number(input?.x) || 0, -1, 1);
    const y = clamp(Number(input?.y) || 0, -1, 1);
    const length = Math.hypot(x, y);

    if (length > 1) {
      p.inputX = x / length;
      p.inputY = y / length;
    } else {
      p.inputX = x;
      p.inputY = y;
    }

    if (Math.hypot(p.inputX, p.inputY) > 0.05) {
      p.faceX = p.inputX;
      p.faceY = p.inputY;
    }
  });

  socket.on('emote', (rawType) => {
    const p = players.get(socket.id);
    if (!p) return;

    const type = String(rawType || '').toLowerCase();
    const allowed = ['wave', 'cheer', 'dance', 'heart'];
    if (!allowed.includes(type)) return;

    p.emote = type;
    p.emoteUntil = Date.now() + 2200;
    broadcastPulse({ type: 'emote', x: p.x, y: p.y - 22, emote: type, playerId: p.playerId });
  });

  socket.on('spark', () => {
    const p = players.get(socket.id);
    if (!p) return;
    socialSpark(socket, p);
  });

  socket.on('rename', (rawName) => {
    const p = players.get(socket.id);
    if (!p) return;

    const name = cleanName(rawName);
    p.name = name;

    const profile = profiles.get(p.playerId);
    if (profile) {
      profile.name = name;
      profile.updatedAt = Date.now();
      scheduleProfileSave();
    }
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (!p) return;
    persistPlayerProgress(p);
    players.delete(socket.id);
    broadcastPulse({ type: 'leave', x: p.x, y: p.y, text: `${p.name} drifted away` });
  });
});

setInterval(gameTick, TICK_MS);
setInterval(spawnSeeds, 900);
setInterval(cleanPulses, 1000);

server.listen(PORT, () => {
  console.log(`Glowbound Grove running at http://localhost:${PORT}`);
});

function gameTick() {
  const now = Date.now();
  const dt = TICK_MS / 1000;

  for (const p of players.values()) {
    updatePlayer(p, dt, now);
    collectNearbySeeds(p);
    depositSeeds(p);
    persistPlayerProgress(p, false);
  }

  if (now - lastSnapshotAt >= SNAPSHOT_MS) {
    lastSnapshotAt = now;
    io.emit('snapshot', createSnapshot(now));
  }
}

function updatePlayer(p, dt, now) {
  p.vx = p.inputX * PLAYER_SPEED;
  p.vy = p.inputY * PLAYER_SPEED;
  p.x = clamp(p.x + p.vx * dt, 36, WORLD.width - 36);
  p.y = clamp(p.y + p.vy * dt, 36, WORLD.height - 36);

  if (p.emoteUntil && now > p.emoteUntil) {
    p.emote = null;
    p.emoteUntil = 0;
  }

  const distToGrove = distance(p.x, p.y, WORLD.grove.x, WORLD.grove.y);
  if (distToGrove <= DEPOSIT_RADIUS) p.status = 'at grove';
  else if (p.carried > 0) p.status = 'carrying';
  else p.status = 'roaming';
}

function collectNearbySeeds(p) {
  for (const [id, seed] of seeds) {
    if (distance(p.x, p.y, seed.x, seed.y) <= COLLECT_RADIUS) {
      seeds.delete(id);
      p.carried += 1;
      addXp(p, 3);
      broadcastPulse({ type: 'collect', x: seed.x, y: seed.y, amount: 1, playerId: p.playerId });
      return;
    }
  }
}

function depositSeeds(p) {
  if (p.carried <= 0) return;
  if (distance(p.x, p.y, WORLD.grove.x, WORLD.grove.y) > DEPOSIT_RADIUS) return;

  const amount = p.carried;
  p.carried = 0;
  p.totalDeposited += amount;
  p.coins += amount * 2;
  grovePower += amount;
  addXp(p, amount * 8 + 5);

  broadcastPulse({
    type: 'deposit',
    x: WORLD.grove.x + randomBetween(-48, 48),
    y: WORLD.grove.y + randomBetween(-48, 48),
    amount,
    playerId: p.playerId
  });
}

function socialSpark(socket, p) {
  const now = Date.now();
  if (now - p.lastSparkAt < SPARK_COOLDOWN_MS) {
    socket.emit('notice', {
      type: 'cooldown',
      message: `Spark recharging: ${Math.ceil((SPARK_COOLDOWN_MS - (now - p.lastSparkAt)) / 1000)}s`
    });
    return;
  }

  let nearest = null;
  let nearestDist = Infinity;

  for (const other of players.values()) {
    if (other.id === p.id) continue;
    const d = distance(p.x, p.y, other.x, other.y);
    if (d < nearestDist) {
      nearest = other;
      nearestDist = d;
    }
  }

  if (!nearest || nearestDist > SOCIAL_RADIUS) {
    socket.emit('notice', { type: 'nearby', message: 'Move closer to another player to Spark.' });
    return;
  }

  p.lastSparkAt = now;
  nearest.lastSparkAt = Math.max(nearest.lastSparkAt || 0, now - SPARK_COOLDOWN_MS + 2500);
  addXp(p, 16);
  addXp(nearest, 16);
  p.coins += 1;
  nearest.coins += 1;

  broadcastPulse({
    type: 'spark',
    x: (p.x + nearest.x) / 2,
    y: (p.y + nearest.y) / 2,
    from: p.playerId,
    to: nearest.playerId,
    text: `${p.name} sparked ${nearest.name}`
  });
}

function addXp(p, amount) {
  const before = p.level;
  p.xp += amount;
  p.level = levelFromXp(p.xp);

  if (p.level > before) {
    p.coins += p.level * 5;
    broadcastPulse({ type: 'level', x: p.x, y: p.y - 30, level: p.level, playerId: p.playerId });
  }
}

function createSnapshot(now) {
  return {
    now,
    world: WORLD,
    grovePower,
    online: players.size,
    seeds: [...seeds.values()],
    pulses: pulses.slice(-18),
    players: [...players.values()].map((p) => ({
      id: p.id,
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      x: Math.round(p.x),
      y: Math.round(p.y),
      faceX: round2(p.faceX),
      faceY: round2(p.faceY),
      carried: p.carried,
      xp: p.xp,
      level: p.level,
      coins: p.coins,
      totalDeposited: p.totalDeposited,
      emote: p.emote,
      status: p.status,
      lastSparkAt: p.lastSparkAt
    }))
  };
}

function spawnSeeds() {
  const needed = MAX_SEEDS - seeds.size;
  if (needed <= 0) return;

  const toSpawn = Math.min(3, needed);
  for (let i = 0; i < toSpawn; i += 1) {
    const id = `seed-${nextSeedId++}`;
    const angle = Math.random() * Math.PI * 2;
    const distanceFromCenter = randomBetween(160, 570);
    const x = clamp(WORLD.grove.x + Math.cos(angle) * distanceFromCenter + randomBetween(-80, 80), 50, WORLD.width - 50);
    const y = clamp(WORLD.grove.y + Math.sin(angle) * distanceFromCenter + randomBetween(-80, 80), 50, WORLD.height - 50);
    seeds.set(id, {
      id,
      x: Math.round(x),
      y: Math.round(y),
      hue: Math.round(randomBetween(120, 185)),
      bornAt: Date.now()
    });
  }
}

function seedInitialWorld() {
  while (seeds.size < MAX_SEEDS) spawnSeeds();
}

function broadcastPulse(pulse) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    ...pulse
  };
  pulses.push(item);
  if (pulses.length > 40) pulses.shift();
  io.emit('pulse', item);
}

function cleanPulses() {
  const cutoff = Date.now() - 3500;
  while (pulses.length && pulses[0].createdAt < cutoff) pulses.shift();
}

function normalizeHandshake(auth) {
  return {
    playerId: safeId(auth.playerId),
    name: cleanName(auth.name),
    color: cleanColor(auth.color)
  };
}

function getOrCreateProfile(playerId, name, color) {
  const id = playerId || createId();
  let profile = profiles.get(id);

  if (!profile) {
    profile = {
      playerId: id,
      name: name || randomName(),
      color: color || randomColor(),
      xp: 0,
      coins: 0,
      carried: 0,
      totalDeposited: 0,
      lastSparkAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    profiles.set(id, profile);
    scheduleProfileSave();
    return profile;
  }

  if (name && name !== profile.name) profile.name = name;
  if (color && color !== profile.color) profile.color = color;
  profile.updatedAt = Date.now();
  scheduleProfileSave();
  return profile;
}

function persistPlayerProgress(p, force = false) {
  const profile = profiles.get(p.playerId);
  if (!profile) return;

  profile.name = p.name;
  profile.color = p.color;
  profile.xp = p.xp;
  profile.coins = p.coins;
  profile.carried = p.carried;
  profile.totalDeposited = p.totalDeposited;
  profile.lastSparkAt = p.lastSparkAt;
  profile.updatedAt = Date.now();

  if (force) saveProfiles();
  else scheduleProfileSave();
}

function scheduleProfileSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProfiles();
  }, PROFILE_SAVE_MS);
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILE_PATH)) fs.writeFileSync(PROFILE_PATH, '{}\n', 'utf8');
}

function loadProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    for (const [id, profile] of Object.entries(parsed)) {
      if (!id || !profile) continue;
      profiles.set(id, {
        playerId: id,
        name: cleanName(profile.name),
        color: cleanColor(profile.color) || randomColor(),
        xp: Math.max(0, Number(profile.xp) || 0),
        coins: Math.max(0, Number(profile.coins) || 0),
        carried: Math.max(0, Number(profile.carried) || 0),
        totalDeposited: Math.max(0, Number(profile.totalDeposited) || 0),
        lastSparkAt: Math.max(0, Number(profile.lastSparkAt) || 0),
        createdAt: Number(profile.createdAt) || Date.now(),
        updatedAt: Number(profile.updatedAt) || Date.now()
      });
    }
  } catch (error) {
    console.warn('Could not load profiles. Starting with an empty profile store.', error);
  }
}

function saveProfiles() {
  const out = {};
  for (const [id, profile] of profiles) out[id] = serializeProfile(profile);

  try {
    fs.writeFileSync(PROFILE_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('Could not save profiles:', error);
  }
}

function serializeProfile(profile) {
  return {
    playerId: profile.playerId,
    name: profile.name,
    color: profile.color,
    xp: profile.xp || 0,
    level: levelFromXp(profile.xp || 0),
    coins: profile.coins || 0,
    carried: profile.carried || 0,
    totalDeposited: profile.totalDeposited || 0,
    lastSparkAt: profile.lastSparkAt || 0,
    createdAt: profile.createdAt || Date.now(),
    updatedAt: profile.updatedAt || Date.now()
  };
}

function randomSpawnNearGrove() {
  const angle = Math.random() * Math.PI * 2;
  const radius = randomBetween(80, 210);
  return {
    x: clamp(WORLD.grove.x + Math.cos(angle) * radius, 48, WORLD.width - 48),
    y: clamp(WORLD.grove.y + Math.sin(angle) * radius, 48, WORLD.height - 48)
  };
}

function levelFromXp(xp) {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 72)) + 1);
}

function xpForNextLevel(level) {
  return Math.pow(level, 2) * 72;
}

function cleanName(name) {
  const raw = String(name || '').trim();
  if (!raw) return randomName();
  return raw.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 18) || randomName();
}

function safeId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
}

function cleanColor(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  return '';
}

function randomName() {
  const left = ['Moss', 'Nova', 'Juniper', 'Pixel', 'Clover', 'Echo', 'Comet', 'River', 'Luna', 'Kite'];
  const right = ['Sprite', 'Scout', 'Keeper', 'Bloom', 'Wisp', 'Pip', 'Drifter', 'Muse', 'Buddy', 'Glow'];
  return `${pick(left)} ${pick(right)}`;
}

function randomColor() {
  return pick(['#7cf7d4', '#8ad7ff', '#ffc4e1', '#ffe68a', '#b9ff92', '#d5b3ff', '#ffb36c']);
}

function createId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  for (const p of players.values()) persistPlayerProgress(p, true);
  saveProfiles();
  process.exit(0);
}
