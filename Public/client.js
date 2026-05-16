(() => {
  const STORAGE_KEY = 'glowbound-grove-profile-v1';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  const login = document.getElementById('login');
  const nameInput = document.getElementById('nameInput');
  const joinButton = document.getElementById('joinButton');
  const hud = document.getElementById('hud');
  const joystick = document.getElementById('joystick');
  const stick = document.getElementById('stick');
  const actions = document.getElementById('actions');
  const avatarDot = document.getElementById('avatarDot');
  const playerName = document.getElementById('playerName');
  const playerStats = document.getElementById('playerStats');
  const grovePowerEl = document.getElementById('grovePower');
  const onlineCount = document.getElementById('onlineCount');
  const levelLabel = document.getElementById('levelLabel');
  const nextLabel = document.getElementById('nextLabel');
  const xpFill = document.getElementById('xpFill');
  const notice = document.getElementById('notice');
  const sparkButton = document.getElementById('sparkButton');

  const state = {
    socket: null,
    connected: false,
    selfSocketId: null,
    profile: loadProfile(),
    world: { width: 1400, height: 900, grove: { x: 700, y: 450, radius: 92 } },
    snapshot: { players: [], seeds: [], pulses: [], online: 0, grovePower: 0 },
    localPulses: [],
    camera: { x: 700, y: 450, scale: 1 },
    input: { x: 0, y: 0 },
    dpr: Math.max(1, Math.min(window.devicePixelRatio || 1, 2)),
    viewport: { w: 1, h: 1 },
    time: performance.now(),
    lastInputSent: 0,
    joystick: {
      active: false,
      pointerId: null,
      baseX: 0,
      baseY: 0,
      max: 42
    }
  };

  init();

  function init() {
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 100));

    const suggestedName = state.profile.name || '';
    nameInput.value = suggestedName;
    nameInput.focus({ preventScroll: true });

    joinButton.addEventListener('click', joinGame);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinGame();
    });

    setupControls();
    setupActions();
    setupPwa();
    requestAnimationFrame(frame);
  }

  function joinGame() {
    const name = cleanName(nameInput.value || state.profile.name || 'New Sprite');
    const profile = {
      playerId: state.profile.playerId || createId(),
      name,
      color: state.profile.color || randomColor()
    };
    state.profile = { ...state.profile, ...profile };
    saveProfile(state.profile);

    state.socket = io({
      transports: ['websocket', 'polling'],
      auth: profile
    });

    state.socket.on('connect', () => {
      state.connected = true;
      showNotice('Connected to the grove.');
    });

    state.socket.on('disconnect', () => {
      state.connected = false;
      showNotice('Connection lost. Reconnecting…');
    });

    state.socket.on('welcome', (payload) => {
      state.selfSocketId = payload.socketId;
      state.world = payload.world;
      state.profile = { ...state.profile, ...payload.profile };
      saveProfile(state.profile);
      avatarDot.style.background = state.profile.color;
      avatarDot.style.boxShadow = `0 0 18px ${state.profile.color}`;
      login.classList.add('is-hidden');
      hud.classList.remove('is-hidden');
      joystick.classList.remove('is-hidden');
      actions.classList.remove('is-hidden');
      showNotice('Collect glowseeds and bring them to the center.');
    });

    state.socket.on('snapshot', (snapshot) => {
      state.snapshot = snapshot;
      const self = getSelf();
      if (self) {
        state.profile = {
          ...state.profile,
          name: self.name,
          color: self.color,
          xp: self.xp,
          level: self.level,
          coins: self.coins,
          carried: self.carried,
          totalDeposited: self.totalDeposited
        };
        saveProfile(state.profile);
        updateHud(self, snapshot);
      }
    });

    state.socket.on('pulse', (pulse) => {
      addPulse(pulse);
    });

    state.socket.on('notice', (payload) => {
      showNotice(payload.message || 'Notice');
    });
  }

  function setupControls() {
    joystick.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      joystick.setPointerCapture(event.pointerId);
      state.joystick.active = true;
      state.joystick.pointerId = event.pointerId;
      const rect = joystick.getBoundingClientRect();
      state.joystick.baseX = rect.left + rect.width / 2;
      state.joystick.baseY = rect.top + rect.height / 2;
      updateJoystick(event.clientX, event.clientY);
    });

    joystick.addEventListener('pointermove', (event) => {
      if (!state.joystick.active || event.pointerId !== state.joystick.pointerId) return;
      event.preventDefault();
      updateJoystick(event.clientX, event.clientY);
    });

    const release = (event) => {
      if (event.pointerId !== state.joystick.pointerId) return;
      state.joystick.active = false;
      state.joystick.pointerId = null;
      state.input.x = 0;
      state.input.y = 0;
      stick.style.transform = 'translate(-50%, -50%)';
      sendInput(true);
    };

    joystick.addEventListener('pointerup', release);
    joystick.addEventListener('pointercancel', release);
    joystick.addEventListener('lostpointercapture', () => {
      state.joystick.active = false;
      state.input.x = 0;
      state.input.y = 0;
      stick.style.transform = 'translate(-50%, -50%)';
      sendInput(true);
    });
  }

  function updateJoystick(clientX, clientY) {
    const dx = clientX - state.joystick.baseX;
    const dy = clientY - state.joystick.baseY;
    const len = Math.hypot(dx, dy);
    const max = state.joystick.max;
    const clamped = Math.min(len, max);
    const nx = len > 0 ? dx / len : 0;
    const ny = len > 0 ? dy / len : 0;

    state.input.x = nx * (clamped / max);
    state.input.y = ny * (clamped / max);
    stick.style.transform = `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;
    sendInput();
  }

  function setupActions() {
    actions.querySelectorAll('[data-emote]').forEach((button) => {
      button.addEventListener('click', () => {
        const emote = button.getAttribute('data-emote');
        if (!state.socket) return;
        state.socket.emit('emote', emote);
      });
    });

    sparkButton.addEventListener('click', () => {
      if (!state.socket) return;
      state.socket.emit('spark');
    });
  }

  function sendInput(force = false) {
    const now = performance.now();
    if (!state.socket || !state.connected) return;
    if (!force && now - state.lastInputSent < 50) return;
    state.lastInputSent = now;
    state.socket.emit('input', state.input);
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - state.time) / 1000 || 0);
    state.time = now;
    sendInput();
    updateCamera(dt);
    draw(now / 1000);
    requestAnimationFrame(frame);
  }

  function updateCamera(dt) {
    const self = getSelf();
    const targetX = self ? self.x : state.world.width / 2;
    const targetY = self ? self.y : state.world.height / 2;
    const ease = 1 - Math.pow(0.001, dt);

    state.camera.x += (targetX - state.camera.x) * ease;
    state.camera.y += (targetY - state.camera.y) * ease;

    const minDim = Math.min(state.viewport.w, state.viewport.h);
    state.camera.scale = clamp(minDim / 620, 0.58, 1.05);
  }

  function draw(t) {
    const { w, h } = state.viewport;
    ctx.save();
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    drawBackground(w, h);

    ctx.translate(w / 2, h / 2);
    ctx.scale(state.camera.scale, state.camera.scale);
    ctx.translate(-state.camera.x, -state.camera.y);

    drawWorldGrid(t);
    drawGrove(t);
    drawSeeds(t);
    drawPlayers(t);
    drawPulses(t);

    ctx.restore();
  }

  function drawBackground(w, h) {
    const gradient = ctx.createRadialGradient(w * 0.5, h * 0.42, 10, w * 0.5, h * 0.42, Math.max(w, h));
    gradient.addColorStop(0, '#172747');
    gradient.addColorStop(0.58, '#0b1020');
    gradient.addColorStop(1, '#060912');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  }

  function drawWorldGrid(t) {
    const { width, height } = state.world;

    ctx.save();
    ctx.fillStyle = '#0d1728';
    roundRect(ctx, 0, 0, width, height, 42);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    const offset = (t * 10) % 70;
    for (let x = -offset; x <= width; x += 70) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = -offset; y <= height; y += 70) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(113,246,203,0.15)';
    ctx.lineWidth = 4;
    roundRect(ctx, 2, 2, width - 4, height - 4, 42);
    ctx.stroke();
    ctx.restore();
  }

  function drawGrove(t) {
    const grove = state.world.grove;
    const power = state.snapshot.grovePower || 0;
    const pulse = Math.sin(t * 2.4) * 0.5 + 0.5;
    const growth = clamp(power / 250, 0, 1);
    const radius = grove.radius + growth * 34 + pulse * 4;

    ctx.save();
    ctx.translate(grove.x, grove.y);

    const aura = ctx.createRadialGradient(0, 0, 10, 0, 0, radius * 2.6);
    aura.addColorStop(0, 'rgba(113,246,203,0.34)');
    aura.addColorStop(0.42, 'rgba(113,246,203,0.13)');
    aura.addColorStop(1, 'rgba(113,246,203,0)');
    ctx.fillStyle = aura;
    circle(0, 0, radius * 2.6);
    ctx.fill();

    ctx.strokeStyle = 'rgba(136,216,255,0.32)';
    ctx.lineWidth = 3;
    circle(0, 0, 112);
    ctx.stroke();

    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2 + t * 0.22;
      const r = 36 + growth * 34 + Math.sin(t * 2 + i) * 4;
      ctx.fillStyle = i % 2 ? '#8ad7ff' : '#71f6cb';
      circle(Math.cos(a) * r, Math.sin(a) * r, 5 + growth * 3);
      ctx.fill();
    }

    ctx.fillStyle = '#132f3a';
    circle(0, 0, radius * 0.84);
    ctx.fill();

    ctx.fillStyle = '#71f6cb';
    ctx.globalAlpha = 0.88;
    circle(0, 0, 38 + growth * 24);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GROVE', 0, 8);
    ctx.restore();
  }

  function drawSeeds(t) {
    for (const seed of state.snapshot.seeds || []) {
      const bob = Math.sin(t * 3 + seed.x * 0.01) * 4;
      ctx.save();
      ctx.translate(seed.x, seed.y + bob);
      ctx.fillStyle = `hsla(${seed.hue || 155}, 92%, 72%, 0.18)`;
      circle(0, 0, 21);
      ctx.fill();
      ctx.fillStyle = `hsl(${seed.hue || 155}, 92%, 72%)`;
      circle(0, 0, 8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      circle(-3, -4, 2.2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPlayers(t) {
    const players = [...(state.snapshot.players || [])].sort((a, b) => a.y - b.y);
    for (const player of players) drawPlayer(player, t, player.id === state.selfSocketId);
  }

  function drawPlayer(player, t, isSelf) {
    const level = player.level || 1;
    const radius = 18 + Math.min(8, level * 0.9);
    const bob = Math.sin(t * 5 + player.x * 0.02) * 2.5;

    ctx.save();
    ctx.translate(player.x, player.y + bob);

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, radius + 8, radius * 1.1, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    if (isSelf) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 3;
      circle(0, 0, radius + 10 + Math.sin(t * 4) * 2);
      ctx.stroke();
    }

    const aura = ctx.createRadialGradient(0, 0, 4, 0, 0, radius * 2.4);
    aura.addColorStop(0, withAlpha(player.color, 0.42));
    aura.addColorStop(1, withAlpha(player.color, 0));
    ctx.fillStyle = aura;
    circle(0, 0, radius * 2.3);
    ctx.fill();

    ctx.fillStyle = player.color || '#71f6cb';
    circle(0, 0, radius);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    circle(-radius * 0.35, -radius * 0.38, radius * 0.28);
    ctx.fill();

    const eyeX = clamp(player.faceX || 0, -1, 1) * 5;
    const eyeY = clamp(player.faceY || 0, -1, 1) * 3;
    ctx.fillStyle = '#06101c';
    circle(-6 + eyeX, -3 + eyeY, 2.3);
    circle(6 + eyeX, -3 + eyeY, 2.3);
    ctx.fill();

    if (player.carried > 0) {
      ctx.fillStyle = '#ffe68a';
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      roundRect(ctx, radius - 2, -radius - 6, 28, 22, 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#241607';
      ctx.font = '800 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(player.carried), radius + 12, -radius + 9);
    }

    drawNameplate(player, radius, isSelf);
    if (player.emote) drawEmote(player.emote, radius, t);

    ctx.restore();
  }

  function drawNameplate(player, radius, isSelf) {
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const label = `${player.name} · Lv ${player.level || 1}`;
    const width = Math.min(178, ctx.measureText(label).width + 20);
    const y = -radius - 38;

    ctx.fillStyle = isSelf ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.36)';
    roundRect(ctx, -width / 2, y - 14, width, 24, 12);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fillText(label, 0, y + 3, width - 14);
  }

  function drawEmote(type, radius, t) {
    const icons = { wave: '👋', cheer: '✨', dance: '🕺', heart: '💚' };
    ctx.font = '26px Apple Color Emoji, Segoe UI Emoji, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(icons[type] || '✨', 0, -radius - 56 - Math.sin(t * 6) * 4);
  }

  function drawPulses(t) {
    const now = Date.now();
    const source = [...(state.snapshot.pulses || []), ...state.localPulses];
    for (const pulse of source) {
      const age = now - pulse.createdAt;
      if (age < 0 || age > 3500) continue;
      const k = age / 3500;
      const y = pulse.y - k * 48;
      const alpha = 1 - k;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(pulse.x, y);

      if (pulse.type === 'collect') {
        ctx.fillStyle = '#ffe68a';
        floatingText(`+${pulse.amount || 1} seed`, 0, 0);
      } else if (pulse.type === 'deposit') {
        ctx.fillStyle = '#71f6cb';
        floatingText(`+${pulse.amount || 1} grove`, 0, 0);
        ctx.strokeStyle = 'rgba(113,246,203,0.48)';
        ctx.lineWidth = 3;
        circle(0, 12, 20 + k * 80);
        ctx.stroke();
      } else if (pulse.type === 'level') {
        ctx.fillStyle = '#ffc4e1';
        floatingText(`Level ${pulse.level}!`, 0, 0);
      } else if (pulse.type === 'spark') {
        ctx.fillStyle = '#8ad7ff';
        floatingText('Spark +16 XP', 0, 0);
        ctx.strokeStyle = 'rgba(136,216,255,0.55)';
        ctx.lineWidth = 4;
        circle(0, 10, 24 + k * 70);
        ctx.stroke();
      } else if (pulse.type === 'emote') {
        const icons = { wave: '👋', cheer: '✨', dance: '🕺', heart: '💚' };
        ctx.font = '28px Apple Color Emoji, Segoe UI Emoji, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(icons[pulse.emote] || '✨', 0, 0);
      } else if (pulse.text) {
        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        floatingText(pulse.text, 0, 0, 13);
      }

      ctx.restore();
    }

    state.localPulses = state.localPulses.filter((pulse) => now - pulse.createdAt < 3500);
  }

  function floatingText(text, x, y, size = 15) {
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 4;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function addPulse(pulse) {
    state.localPulses.push(pulse);
  }

  function updateHud(self, snapshot) {
    playerName.textContent = self.name;
    playerStats.textContent = `Lv ${self.level} · ${self.xp} XP · ${self.coins} coins · ${self.carried} carried`;
    grovePowerEl.textContent = `Grove ${snapshot.grovePower || 0}`;
    onlineCount.textContent = `${snapshot.online || 0} online`;
    avatarDot.style.background = self.color;
    avatarDot.style.boxShadow = `0 0 18px ${self.color}`;

    const currentLevelXp = xpForLevel(self.level - 1);
    const nextLevelXp = xpForLevel(self.level);
    const span = Math.max(1, nextLevelXp - currentLevelXp);
    const pct = clamp(((self.xp - currentLevelXp) / span) * 100, 0, 100);

    levelLabel.textContent = `Level ${self.level}`;
    nextLabel.textContent = `Next: ${Math.max(0, nextLevelXp - self.xp)} XP`;
    xpFill.style.width = `${pct}%`;
  }

  function getSelf() {
    return (state.snapshot.players || []).find((player) => player.id === state.selfSocketId);
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.classList.add('show');
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => notice.classList.remove('show'), 2200);
  }

  function resize() {
    state.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    state.viewport.w = Math.max(1, window.innerWidth);
    state.viewport.h = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(state.viewport.w * state.dpr);
    canvas.height = Math.floor(state.viewport.h * state.dpr);
    canvas.style.width = `${state.viewport.w}px`;
    canvas.style.height = `${state.viewport.h}px`;
  }

  function setupPwa() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }
  }

  function cleanName(name) {
    const value = String(name || '').trim().replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 18);
    return value || 'New Sprite';
  }

  function loadProfile() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  function saveProfile(profile) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  }

  function createId() {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function randomColor() {
    const colors = ['#7cf7d4', '#8ad7ff', '#ffc4e1', '#ffe68a', '#b9ff92', '#d5b3ff', '#ffb36c'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  function xpForLevel(level) {
    return Math.pow(Math.max(0, level), 2) * 72;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function withAlpha(hex, alpha) {
    const clean = String(hex || '#71f6cb').replace('#', '');
    if (clean.length !== 6) return `rgba(113,246,203,${alpha})`;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
})();
