/* Inbox Laser - Game Window (MVP)
 * Rendering: Canvas
 * Controls:
 * - Click a ship to stage it (laser + boom)
 * - Review staged list, restore, or send to Trash
 */

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Polyfill: roundRect for older Gecko builds
if (typeof ctx.roundRect !== 'function') {
  ctx.roundRect = function(x, y, w, h, r) {
    const radius = (typeof r === 'number') ? [r, r, r, r] : (Array.isArray(r) ? r : [0,0,0,0]);
    const [r1, r2, r3, r4] = radius.map(v => Math.max(0, Math.min(v, Math.min(w, h) / 2)));
    this.beginPath();
    this.moveTo(x + r1, y);
    this.lineTo(x + w - r2, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r2);
    this.lineTo(x + w, y + h - r3);
    this.quadraticCurveTo(x + w, y + h, x + w - r3, y + h);
    this.lineTo(x + r4, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r4);
    this.lineTo(x, y + r1);
    this.quadraticCurveTo(x, y, x + r1, y);
    return this;
  };
}


const statusLine = document.getElementById('statusLine');
const btnReview = document.getElementById('btnReview');
const btnReload = document.getElementById('btnReload');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toastText');
const errorPanel = document.getElementById('errorPanel');
const errorText = document.getElementById('errorText');
const btnTryInbox = document.getElementById('btnTryInbox');

const reviewModal = document.getElementById('reviewModal');
const reviewList = document.getElementById('reviewList');
const btnCloseReview = document.getElementById('btnCloseReview');
const btnCloseReview2 = document.getElementById('btnCloseReview2');
const btnRestoreAll = document.getElementById('btnRestoreAll');
const btnScrap = document.getElementById('btnScrap');
const reviewResult = document.getElementById('reviewResult');

// Force the review overlay fully closed at load. Some popup builds can be quirky with [hidden].
setReviewOpen(false);

/** @type {string|null} */
let folderId = null;
/** @type {Array<{id:number, author:string, subject:string, date:number, folderId:string}>} */
let wave = [];

const state = {
  ships: [],
  staged: new Set(),
  particles: [],
  lasers: [],
  mouse: { x: 400, y: 300 },
  fleet: {
    offsetX: 140,
    offsetY: 70,
    dir: -1,
    speed: 42,
    stepDown: 22,
    boundsPadding: 16
  }
};

// --- Audio (no asset files) ---
let audioCtx = null;
function pew() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(220, t0 + 0.12);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  } catch {
    // ignore
  }
}

function boom() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.18);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.22);
  } catch {
    // ignore
  }
}

// --- Messaging helpers ---
async function bg(type, payload) {
  return await browser.runtime.sendMessage({ type, payload });
}

// --- UI helpers ---
let toastTimer = null;
function showToast(text) {
  toastText.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1400);
}

function showError(text) {
  errorText.textContent = text;
  errorPanel.hidden = false;
  statusLine.textContent = 'Error, could not load messages.';
}

function clearError() {
  errorPanel.hidden = true;
}

function setStatus(text) {
  statusLine.textContent = text;
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

// --- Ship layout ---
function buildShips() {
  const cols = 6;
  const gapX = 18;
  const gapY = 18;
  const shipW = 110;
  const shipH = 44;

  state.ships = wave.map((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      message: m,
      x: col * (shipW + gapX),
      y: row * (shipH + gapY),
      w: shipW,
      h: shipH,
      alive: true,
      staged: false,
      wobble: 0
    };
  });

  // Reset fleet placement.
  state.fleet.offsetX = 140;
  state.fleet.offsetY = 70;
  state.fleet.dir = -1; // left first
  state.fleet.speed = 42;
}

function fleetBounds() {
  const alive = state.ships.filter(s => s.alive);
  if (!alive.length) return { left: 0, right: 0, top: 0, bottom: 0 };
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const s of alive) {
    left = Math.min(left, s.x);
    right = Math.max(right, s.x + s.w);
    top = Math.min(top, s.y);
    bottom = Math.max(bottom, s.y + s.h);
  }
  return { left, right, top, bottom };
}

function truncateToWidth(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ell;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const cut = Math.max(0, lo - 1);
  return text.slice(0, cut) + ell;
}

// --- Rendering ---
function drawBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Subtle grid.
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = 'rgba(231,240,255,0.08)';
  for (let x = 0; x <= canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShipShape(x, y, w, h, glow, isStaged) {
  ctx.save();
  ctx.translate(x, y);

  const fill = isStaged ? 'rgba(255, 60, 110, 0.10)' : 'rgba(60, 255, 192, 0.10)';
  const stroke = isStaged ? 'rgba(255, 60, 110, 0.70)' : 'rgba(60, 255, 192, 0.70)';

  if (glow) {
    ctx.shadowBlur = 18;
    ctx.shadowColor = stroke;
  }

  // Body
  ctx.beginPath();
  ctx.roundRect(10, 8, w - 20, h - 16, 10);
  ctx.fillStyle = fill;
  ctx.fill();

  // Wings
  ctx.beginPath();
  ctx.moveTo(10, 14);
  ctx.lineTo(0, h / 2);
  ctx.lineTo(10, h - 14);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(w - 10, 14);
  ctx.lineTo(w, h / 2);
  ctx.lineTo(w - 10, h - 14);
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.shadowBlur = 0;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(10, 8, w - 20, h - 16);

  ctx.restore();
}

function drawShips() {
  const { offsetX, offsetY } = state.fleet;

  ctx.save();
  ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  ctx.textBaseline = 'middle';

  for (const s of state.ships) {
    if (!s.alive) continue;

    const gx = offsetX + s.x;
    const gy = offsetY + s.y;

    drawShipShape(gx, gy, s.w, s.h, s.wobble > 0, s.staged);

    // Text
    const pad = 14;
    ctx.save();
    ctx.fillStyle = 'rgba(231,240,255,0.95)';
    ctx.shadowBlur = 6;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';

    const from = (s.message.author || '').replace(/\s+/g, ' ').trim();
    const subject = (s.message.subject || '').replace(/\s+/g, ' ').trim();
    const line = `${from} · ${subject}`;
    const txt = truncateToWidth(line, s.w - pad * 2);
    ctx.fillText(txt, gx + pad, gy + s.h / 2);

    ctx.restore();
  }

  ctx.restore();
}

function drawLasers(now) {
  for (const l of state.lasers) {
    const age = now - l.started;
    const t = Math.max(0, 1 - age / l.ttl);
    ctx.save();
    ctx.globalAlpha = t;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(60,255,192,0.85)';
    ctx.shadowBlur = 18;
    ctx.shadowColor = 'rgba(60,255,192,0.85)';
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawCrosshair() {
  const { x, y } = state.mouse;
  ctx.save();
  ctx.strokeStyle = 'rgba(231,240,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 10, y);
  ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10);
  ctx.lineTo(x, y + 10);
  ctx.stroke();
  ctx.restore();
}

function render(now) {
  drawBackground();
  drawShips();
  drawLasers(now);
  drawParticles();
  drawCrosshair();
}

// --- Simulation ---
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.04, (now - last) / 1000);
  last = now;

  // Fleet motion
  const aliveCount = state.ships.filter(s => s.alive).length;
  const stagedCount = state.ships.filter(s => s.alive && s.staged).length;
  const remaining = Math.max(1, aliveCount - stagedCount);

  const speedBoost = 1 + (1 - remaining / Math.max(1, aliveCount)) * 0.8;
  const speed = state.fleet.speed * speedBoost;

  const bounds = fleetBounds();
  const leftEdge = state.fleet.offsetX + bounds.left;
  const rightEdge = state.fleet.offsetX + bounds.right;

  state.fleet.offsetX += state.fleet.dir * speed * dt;

  const pad = state.fleet.boundsPadding;
  if (leftEdge < pad && state.fleet.dir < 0) {
    state.fleet.dir = 1;
    state.fleet.offsetY += state.fleet.stepDown;
  } else if (rightEdge > canvas.width - pad && state.fleet.dir > 0) {
    state.fleet.dir = -1;
    state.fleet.offsetY += state.fleet.stepDown;
  }

  // Wobble decay
  for (const s of state.ships) s.wobble = Math.max(0, s.wobble - dt * 2.8);

  // Lasers
  state.lasers = state.lasers.filter(l => now - l.started < l.ttl);

  // Particles
  for (const p of state.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.98;
    p.vy *= 0.98;
    p.life -= dt * 1.9;
    p.r *= 0.995;
  }
  state.particles = state.particles.filter(p => p.life > 0.02);

  render(now);

  requestAnimationFrame(tick);
}

// --- Interaction ---
function canvasToLocal(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
  return { x, y };
}

function shipAtPoint(x, y) {
  const { offsetX, offsetY } = state.fleet;
  for (let i = state.ships.length - 1; i >= 0; i--) {
    const s = state.ships[i];
    if (!s.alive) continue;
    const gx = offsetX + s.x;
    const gy = offsetY + s.y;
    if (x >= gx && x <= gx + s.w && y >= gy && y <= gy + s.h) return s;
  }
  return null;
}

function spawnExplosion(x, y, isStaged) {
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 50 + Math.random() * 160;
    state.particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      r: 2 + Math.random() * 2.5,
      life: 0.95,
      color: isStaged ? 'rgba(255,60,110,0.95)' : 'rgba(60,255,192,0.95)'
    });
  }
}

async function toggleStage(ship) {
  const already = ship.staged;
  const next = !already;

  // Laser effect
  const { offsetX, offsetY } = state.fleet;
  const gx = offsetX + ship.x + ship.w / 2;
  const gy = offsetY + ship.y + ship.h / 2;
  state.lasers.push({
    x1: canvas.width / 2,
    y1: canvas.height - 10,
    x2: gx,
    y2: gy,
    started: performance.now(),
    ttl: 160
  });

  next ? pew() : boom();
  spawnExplosion(gx, gy, next);

  ship.staged = next;
  ship.wobble = 1.0;

  if (next) state.staged.add(ship.message.id);
  else state.staged.delete(ship.message.id);

  try {
    await bg('inboxLaser:stageSet', {
      folderId,
      message: ship.message,
      staged: next
    });
    showToast(next ? 'Staged for Scrap Yard.' : 'Restored to fleet.');
  } catch (err) {
    // Rollback
    ship.staged = already;
    if (already) state.staged.add(ship.message.id);
    else state.staged.delete(ship.message.id);
    showToast('Could not update staged list.');
  }

  updateStatusCounts();
}

function updateStatusCounts() {
  const staged = state.ships.filter(s => s.alive && s.staged).length;
  const total = state.ships.filter(s => s.alive).length;
  setStatus(`Wave 1, staged ${staged}/${total}. Click ships to stage.`);
}

canvas.addEventListener('mousemove', (ev) => {
  state.mouse = canvasToLocal(ev);
});

canvas.addEventListener('click', async (ev) => {
  if (!reviewModal.hidden) return;
  if (!errorPanel.hidden) return;

  const { x, y } = canvasToLocal(ev);
  const ship = shipAtPoint(x, y);
  if (!ship) return;

  await toggleStage(ship);
});

// --- Review modal ---
function setReviewOpen(open) {
  // In some Gecko builds, relying on [hidden] alone can be flaky for pointer routing.
  // We toggle BOTH hidden + inline display to guarantee the overlay never intercepts clicks when closed.
  reviewModal.hidden = !open;
  reviewModal.style.display = open ? 'grid' : 'none';
  btnReview.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function openReview() {
  reviewResult.hidden = true;
  reviewResult.textContent = '';
  setReviewOpen(true);
  // Focus a control inside the modal so Escape works reliably.
  try { btnCloseReview.focus(); } catch (_) {}
  refreshReview().catch((err) => {
    reviewResult.hidden = false;
    reviewResult.textContent = `Could not load staged list: ${String(err?.message || err)}`;
  });
}

function closeReview() {
  setReviewOpen(false);
  try {
    canvas.focus();
  } catch (_) {
    // Guard: focus failures should not block interaction.
  }
}

function buildReviewItem(item) {
  const wrap = document.createElement('div');
  wrap.className = 'item';

  const left = document.createElement('div');

  const top = document.createElement('div');
  top.className = 'item__top';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = 'STAGED';

  const subj = document.createElement('span');
  subj.className = 'item__subject';
  subj.textContent = item.subject;

  top.appendChild(badge);
  top.appendChild(subj);

  const meta = document.createElement('div');
  meta.className = 'item__meta';
  meta.textContent = `${item.author} · ${fmtDate(item.date)}`;

  left.appendChild(top);
  left.appendChild(meta);

  const right = document.createElement('div');
  right.className = 'item__actions';

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.textContent = 'Remove';
  btn.addEventListener('click', async () => {
    await bg('inboxLaser:stageSet', { folderId, message: item, staged: false });
    // Update local ship state if present.
    const ship = state.ships.find(s => s.message.id === item.id);
    if (ship) {
      ship.staged = false;
      state.staged.delete(item.id);
    }
    updateStatusCounts();
    await refreshReview();
  });

  right.appendChild(btn);

  wrap.appendChild(left);
  wrap.appendChild(right);

  return wrap;
}

async function refreshReview() {
  const res = await bg('inboxLaser:stageGet', { folderId });
  const items = res?.items || [];

  reviewList.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'item__meta';
    p.textContent = 'No staged messages yet. Go blast some ships.';
    reviewList.appendChild(p);
  } else {
    for (const item of items) reviewList.appendChild(buildReviewItem(item));
  }
}

btnReview.addEventListener('click', () => {
  if (!reviewModal.hidden) {
    closeReview();
  } else {
    openReview();
  }
});
// Use pointerdown so we close even if click is swallowed by focus changes.
btnCloseReview.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  closeReview();
});
btnCloseReview.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  closeReview();
});
btnCloseReview2.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  closeReview();
});
btnCloseReview2.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  closeReview();
});

// Safety hatch: Escape closes the review modal.
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !reviewModal.hidden) {
    ev.preventDefault();
    closeReview();
  }
}, true);

// Click outside the card closes the modal.
reviewModal.addEventListener('pointerdown', (ev) => {
  if (ev.target === reviewModal) closeReview();
}, true);

btnRestoreAll.addEventListener('click', async () => {
  await bg('inboxLaser:stageClear', { folderId });
  for (const s of state.ships) s.staged = false;
  state.staged.clear();
  updateStatusCounts();
  await refreshReview();
  showToast('Restored all staged messages.');
});

btnScrap.addEventListener('click', async () => {
  const ok = window.confirm('Send staged messages to Trash now?');
  if (!ok) return;

  btnScrap.disabled = true;
  reviewResult.hidden = true;

  try {
    const res = await bg('inboxLaser:trashStaged', { folderId });
    const trashed = res?.trashed?.length || 0;
    const failed = res?.failed?.length || 0;

    // Mark successfully trashed ships as removed.
    const trashedIds = new Set(res?.trashed || []);
    for (const s of state.ships) {
      if (trashedIds.has(s.message.id)) {
        s.alive = false;
        s.staged = false;
      }
    }

    state.staged = new Set(state.ships.filter(s => s.alive && s.staged).map(s => s.message.id));
    updateStatusCounts();

    reviewResult.hidden = false;
    if (failed > 0) {
      reviewResult.textContent = `Moved ${trashed} message(s) to Trash. ${failed} failed, and remained staged.`;
    } else {
      reviewResult.textContent = `Moved ${trashed} message(s) to Trash.`;
    }

    await refreshReview();
  } catch (err) {
    reviewResult.hidden = false;
    reviewResult.textContent = `Could not move messages to Trash: ${String(err?.message || err)}`;
  } finally {
    btnScrap.disabled = false;
  }
});

// --- Buttons ---
btnReload.addEventListener('click', () => init().catch(() => {}));
btnTryInbox.addEventListener('click', () => init().catch(() => {}));

// --- Init ---
async function init() {
  clearError();
  setStatus('Loading Wave 1…');

  try {
    const res = await bg('inboxLaser:getWave1', {});
    folderId = res.folderId;
    wave = res.messages || [];

    if (!wave.length) {
      setStatus('Wave 1 loaded, but Inbox is empty (or nothing matched).');
      state.ships = [];
      return;
    }

    // Load staging state from background (in case we crashed last time).
    const staging = await bg('inboxLaser:stageGet', { folderId });
    const stagedIds = new Set((staging?.items || []).map(i => i.id));

    buildShips();
    for (const s of state.ships) {
      if (stagedIds.has(s.message.id)) {
        s.staged = true;
        state.staged.add(s.message.id);
      }
    }

    updateStatusCounts();

  } catch (err) {
    showError(String(err?.message || err));
  }
}

// Start
init().catch(err => showError(String(err?.message || err)));
requestAnimationFrame(tick);
