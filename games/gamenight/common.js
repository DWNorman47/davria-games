// Helpers shared by the TV screen (tv.html) and the phone screen (index.html).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

const GAME_NAMES = { quip: 'Quip Clash', bluff: 'Bluff', story: 'Story Chain' };

// PeerJS: the TV registers as PEER_PREFIX + room code; phones connect to it.
const PEER_PREFIX = 'gamenight-davria-';
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 12000;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genRoomCode = () => Array.from({ length: 6 }, () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join('');
const normalizeRoomCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

// localStorage can be blocked (private mode), so never let it throw.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let clockSkew = 0;
const serverNow = () => Date.now() + clockSkew;

function av(p, cls = '', i = 0) {
  return `<span class="av ${cls}" style="--pc:${esc(p.color)};--i:${i}"><i>${esc(p.avatar)}</i></span>`;
}

// "Ann", "Ann & Bob", "Ann, Bob & Cy", "Ann, Bob, Cy & 4 more"
function names(ps) {
  const n = ps.map(p => esc(p.name));
  if (n.length <= 2) return n.join(' & ');
  if (n.length <= 4) return `${n.slice(0, -1).join(', ')} & ${n[n.length - 1]}`;
  return `${n.slice(0, 3).join(', ')} & ${n.length - 3} more`;
}

const fmtQ = q => esc(q).replace(/_{3,}/g, '<span class="blank"></span>');

function toast(msg, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function setOnline(on, label = 'Reconnecting…') {
  let bar = $('#offline');
  if (on) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'offline';
    document.body.appendChild(bar);
  }
  bar.textContent = label;
}

// Countdown timers: any `.timer` element counts down to its data-deadline.
function syncTimers(deadline) {
  for (const t of $$('.timer')) t.dataset.deadline = deadline || '';
}

const tickFns = [];
const everyTick = fn => tickFns.push(fn);
setInterval(() => {
  for (const t of $$('.timer')) {
    const d = Number(t.dataset.deadline);
    t.hidden = !d;
    if (!d) continue;
    const secs = String(Math.max(0, Math.ceil((d - serverNow()) / 1000)));
    if (t.textContent !== secs) t.textContent = secs;
    t.classList.toggle('low', Number(secs) <= 10);
  }
  for (const fn of tickFns) fn();
}, 200);
