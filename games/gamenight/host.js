// TV / host screen. Runs the game engine, hosts the PeerJS room that phones
// join, and draws the big-screen side of each game.

const app = $('#app');
const WAITING = new Set(['answer', 'vote', 'finalVote', 'write', 'pick', 'chain', 'storyVote']);
const SAVE_KEY = 'gamenight-host';

let S = null;
let shownKey = '';
let stageKey = '';
let qrUrl = '';
let lastTickSec = null;
let muted = store.get('muted') === '1';

let roomCode = '';
let peer = null;
let roomOpen = false;
const phones = new Map(); // PeerJS DataConnection -> { conn, pid, lastSeen }

const engine = createGameNight({
  content: GAME_NIGHT_CONTENT,
  onUpdate: pushState,
  onKick: pid => {
    for (const ph of phones.values()) {
      if (ph.pid === pid) { send(ph.conn, { type: 'kicked' }); ph.pid = null; }
    }
  },
});

window.addEventListener('qr-ready', () => { qrUrl = ''; if (S) render(); });

// ---------- room hosting (PeerJS) ----------

function send(conn, msg) {
  try { if (conn.open) conn.send(msg); } catch { /* connection closing */ }
}

let retryTimer = null;
function retryLater(fn, ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(fn, ms);
}

function openRoom(code, resuming, attempt = 0) {
  roomCode = code;
  roomOpen = false;
  qrUrl = '';
  setOnline(false, resuming ? 'Reopening your room…' : 'Opening a room…');
  try { peer?.destroy(); } catch { /* already gone */ }
  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  peer.on('open', () => {
    roomOpen = true;
    setOnline(true);
    saveNow();
    if (S) render();
  });
  peer.on('connection', onPhoneConnection);
  peer.on('disconnected', () => {
    // Lost the matchmaking server; phones already connected keep working.
    setOnline(false, 'Reconnecting to the connection server… (players already in can keep playing)');
    retryLater(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
  });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') return;
    if (err.type === 'unavailable-id') {
      // After a refresh the old room can take a little while to free up.
      if (resuming && attempt < 30) return retryLater(() => openRoom(code, true, attempt + 1), 2000);
      return openRoom(genRoomCode(), false);
    }
    console.warn('PeerJS error:', err.type, err);
    setOnline(false, phones.size
      ? 'Reconnecting to the connection server… (players already in can keep playing)'
      : 'Can’t reach the connection server. Check the internet. Retrying…');
    retryLater(() => {
      if (peer.destroyed) openRoom(roomCode, true, attempt + 1);
      else if (peer.disconnected) peer.reconnect();
    }, 3000);
  });
}

function onPhoneConnection(conn) {
  const ph = { conn, pid: null, lastSeen: Date.now() };
  phones.set(conn, ph);
  conn.on('data', msg => { ph.lastSeen = Date.now(); onPhoneMessage(ph, msg); });
  conn.on('close', () => dropPhone(ph));
  conn.on('error', () => dropPhone(ph));
}

function dropPhone(ph) {
  if (!phones.delete(ph.conn)) return;
  if (ph.pid) engine.detach(ph.pid);
  try { ph.conn.close(); } catch { /* already closed */ }
}

function onPhoneMessage(ph, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      return send(ph.conn, { type: 'avatars', avatars: engine.avatars() });
    case 'join': {
      let pid = msg.pid && engine.has(msg.pid) ? msg.pid : null;
      if (!pid) {
        // A phone rejoining a room that no longer knows it starts over at the join screen.
        if (!msg.name) return send(ph.conn, { type: 'reject', reason: 'reset', avatars: engine.avatars() });
        const r = engine.join({ name: msg.name, avatar: msg.avatar });
        if (!r.ok) return send(ph.conn, { type: 'reject', reason: r.error, avatars: engine.avatars() });
        pid = r.pid;
      }
      if (ph.pid !== pid) {
        if (ph.pid) engine.detach(ph.pid);
        ph.pid = pid;
        engine.attach(pid);
      }
      send(ph.conn, { type: 'joined', pid });
      send(ph.conn, { type: 'state', view: engine.view(pid) });
      return;
    }
    case 'act': {
      const r = ph.pid ? engine.act(ph.pid, msg.body || {}) : { ok: false, error: 'reset' };
      return send(ph.conn, { type: 'result', reqId: msg.reqId, ...r });
    }
  }
}

// Pings keep phones' watchdogs happy; phones that stop answering are let go.
setInterval(() => {
  const now = Date.now();
  for (const ph of [...phones.values()]) {
    if (now - ph.lastSeen > HEARTBEAT_TIMEOUT_MS) dropPhone(ph);
    else send(ph.conn, { type: 'ping' });
  }
}, HEARTBEAT_INTERVAL_MS);

// Called by the engine whenever anything changes.
function pushState() {
  const before = S?.game ? `${S.game.phase}|${S.game.phaseStart}` : '';
  S = engine.view(null);
  render();
  const after = S.game ? `${S.game.phase}|${S.game.phaseStart}` : '';
  if (after && after !== before) phaseSound(S.game.phase);
  for (const ph of phones.values()) {
    if (!ph.pid) continue;
    const view = engine.view(ph.pid);
    if (view) send(ph.conn, { type: 'state', view });
  }
  scheduleSave();
}

let saveTimer = null;
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 1000);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { sessionStorage.setItem(SAVE_KEY, JSON.stringify({ roomCode, snapshot: engine.save(), savedAt: Date.now() })); } catch { /* storage full or blocked */ }
}
function loadSaved() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null');
    if (s?.roomCode && s.snapshot && Date.now() - s.savedAt < 6 * 3600 * 1000) return s;
  } catch { /* corrupt save */ }
  return null;
}
window.addEventListener('pagehide', saveNow);

function render() {
  const g = S.game;
  const key = g ? `${g.type}|${g.phase}|${g.phaseStart}` : 'lobby';
  if (key !== shownKey) {
    shownKey = key;
    stageKey = '';
    qrUrl = '';
    app.innerHTML = g ? SCREENS[g.phase](g) : lobby();
    if (g?.phase === 'read') fitStory();
  }
  syncTimers(g && WAITING.has(g.phase) ? g.deadline : null);
  renderProgress(g?.progress);
  if (!g) liveLobby();
  if (g?.phase === 'reveal') liveReveal(g);
  $('#controls').classList.toggle('in-game', !!g && g.phase !== 'end');
  $('#corner-join').textContent = g && roomCode ? `Join with code ${roomCode}` : '';
}

// ---------- lobby ----------

// Phones join through index.html in this same folder.
const joinUrl = () => new URL(`./?room=${roomCode}`, location.href).href;

function lobby() {
  return `<div class="lobby">
    <header class="brand"><h1>Game Night</h1><p>Grab your phone and jump in!</p><a class="back-link" href="../../index.html">← Game Arcade</a></header>
    <div class="lobby-grid">
      <section class="join-card">
        <div class="qr" id="qr"></div>
        <div class="join-label">Scan to join, or open Game Night on your phone and enter</div>
        <div class="room-code" id="room-code"></div>
        <div class="join-label" id="room-status"></div>
        <button class="link" id="new-room">Use a new room code</button>
      </section>
      <section class="roster">
        <h2>Players <span id="count" class="muted"></span></h2>
        <div id="roster" class="roster-grid"></div>
      </section>
    </div>
    <div class="game-picks">
      <button class="pick quip" data-start="quip"><b>Quip Clash</b><span>Write the funniest answer to silly prompts. Everyone votes head-to-head.</span></button>
      <button class="pick bluff" data-start="bluff"><b>Bluff</b><span>Fake answers to strange-but-true trivia. Fool your friends, find the truth.</span></button>
      <button class="pick story" data-start="story"><b>Story Chain</b><span>Write a story one line at a time, seeing only the line before. Then read it aloud!</span></button>
    </div>
    <p class="need muted" id="need"></p>
  </div>`;
}

function liveLobby() {
  const ps = S.players;
  const url = roomOpen ? joinUrl() : '';
  if (url !== qrUrl) {
    qrUrl = url;
    $('#room-code').textContent = roomCode;
    $('#room-status').textContent = roomOpen ? '' : 'Opening the room…';
    $('#qr').innerHTML = url && window.qrcode ? qrImg(url) : '';
  }
  const roster = $('#roster');
  const sig = ps.map(p => p.pid).join();
  if (roster.dataset.sig !== sig) {
    roster.dataset.sig = sig;
    roster.innerHTML = ps.length
      ? ps.map(p => `<div class="rp" data-pid="${p.pid}">${av(p)}<span class="nm">${esc(p.name)}</span><button class="kick" data-kick="${p.pid}" title="Remove ${esc(p.name)}">✕</button></div>`).join('')
      : '<p class="empty">Nobody here yet. Scan the code to join!</p>';
  }
  for (const p of ps) roster.querySelector(`[data-pid="${p.pid}"]`)?.classList.toggle('away', !p.active);
  $('#count').textContent = ps.length ? `(${ps.length})` : '';
  const short = ps.length < S.minPlayers;
  for (const b of $$('[data-start]')) b.disabled = short;
  $('#need').textContent = short ? `You need at least ${S.minPlayers} players to start.` : 'Pick a game to start!';
}

function qrImg(url) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createImgTag(8, 8, 'QR code to join');
  } catch {
    return '';
  }
}

// ---------- in-game screens ----------

function topbar(g, withTimer, extra = '') {
  const parts = g.type === 'story' ? [] : [g.roundLabel];
  if (g.type === 'bluff' && g.qNum) parts.push(`Question ${g.qNum} of ${g.qCount}`);
  if (g.matchNum) parts.push(`Matchup ${g.matchNum} of ${g.matchCount}`);
  if (g.phase === 'chain') parts.push(`Line ${g.turn} of ${g.lines}`);
  if (g.phase === 'read') parts.push(`Story ${g.storyNum} of ${g.storyCount}`);
  if (g.mult > 1) parts.push(`${g.mult}× points`);
  return `<div class="topbar">
    <span class="logo-sm ${g.type}">${GAME_NAMES[g.type]}</span>
    <span class="crumbs">${esc(parts.join(' · '))}${extra}</span>
    ${withTimer ? '<div class="timer"></div>' : ''}
  </div>`;
}

// Story lines can be long; shrink the text until the whole story fits on screen.
function fitStory() {
  const book = $('.storybook');
  if (!book) return;
  let size = 1.8;
  book.style.setProperty('--fs', `${size}rem`);
  while (book.scrollHeight > book.clientHeight + 1 && size > 0.9) {
    size -= 0.08;
    book.style.setProperty('--fs', `${size}rem`);
  }
}
window.addEventListener('resize', () => { if (S?.game?.phase === 'read') fitStory(); });

function readerCue(g) {
  if (g.theEnd) return '👏 THE END! Give it up for this story!';
  if (!g.reader) return '📖 The narrator stepped in on this line (someone ran out of time)';
  const who = `${av(g.reader, 'sm')} <b>${esc(g.reader.name)}</b>`;
  return g.lineIdx === 0 ? `📣 ${who}, read the opening and your line out loud!` : `📣 ${who}, read your line out loud!`;
}

function storyCard(o, i, foot = '') {
  return `<div class="fa ${foot && o.win ? 'win' : ''}" style="--d:${i}">
    ${foot ? '' : `<span class="num">${i + 1}</span>`}
    <div class="st-open">${esc(o.opener)}</div>
    <div class="st-end">…${esc(o.ending)}</div>
    ${foot}
  </div>`;
}

function renderProgress(list) {
  const box = $('#progress');
  if (!box || !list) return;
  const sig = list.map(p => p.pid).join();
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = list.map(p => `<div class="pg" data-pid="${p.pid}">${av(p)}<span>${esc(p.name)}</span></div>`).join('');
  }
  for (const p of list) box.querySelector(`[data-pid="${p.pid}"]`)?.classList.toggle('done', p.done);
}

function quipCard(a, side, anyWinner) {
  const cls = [side ? 'b' : 'a', a.winner ? 'win' : anyWinner ? 'lose' : ''].join(' ');
  return `<div class="answer ${cls}">
    ${a.sweep ? '<div class="badge">CLEAN SWEEP!</div>' : ''}
    <div class="text">${a.text == null ? '<span class="noanswer">(ran out of time)</span>' : esc(a.text)}</div>
    <div class="by">${av(a.author)} ${esc(a.author.name)}</div>
    <div class="votes">${a.voters.map((v, i) => av(v, '', i)).join('')}</div>
    <div class="pts">+${a.points.toLocaleString()}</div>
  </div>`;
}

function standings(g, end) {
  const ps = S.players.slice().sort((a, b) => b.score - a.score);
  const top = ps[0]?.score || 0;
  const winners = top > 0 ? ps.filter(p => p.score === top) : [];
  const cols = ps.length > 12 ? 3 : ps.length > 6 ? 2 : 1;
  const rows = ps.map((p, i) => {
    const rank = ps.findIndex(x => x.score === p.score) + 1;
    const pct = top ? Math.round((p.score / top) * 100) : 0;
    return `<div class="row ${rank === 1 && top > 0 ? 'first' : ''}" style="--d:${i};--pct:${pct}%">
      <span class="rank">${rank}</span>${av(p, 'sm')}<span class="nm">${esc(p.name)}</span><span class="sc">${p.score.toLocaleString()}</span>
    </div>`;
  }).join('');
  const boardStyle = cols > 1 ? `grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${Math.ceil(ps.length / cols)},auto)` : '';
  let title = `<h1>Scores after ${esc(g.roundLabel)}</h1>`;
  if (end) {
    title = `<div class="game-logo ${g.type}">${GAME_NAMES[g.type]} · Final scores</div>`;
    title += winners.length
      ? `<h1 class="winner pop">🏆 ${winners.map(w => `${av(w, 'sm')} ${esc(w.name)}`).join(' & ')} ${winners.length > 1 ? 'tie!' : 'wins!'}</h1>`
      : '<h1>Final Scores</h1>';
  }
  return `<div class="scores">
    ${title}
    <div class="board ${cols > 1 ? 'multi' : ''}" style="${boardStyle}">${rows}</div>
    ${end ? `<div class="end-btns">
      <button class="btn" data-host="again">Play ${GAME_NAMES[g.type]} again</button>
      <button class="btn alt" data-host="end">Pick a different game</button>
    </div>` : ''}
  </div>`;
}

const SCREENS = {
  intro: g => `<div class="intro">
    <div class="game-logo ${g.type}">${GAME_NAMES[g.type]}</div>
    <h1 class="round-label pop">${esc(g.roundLabel)}</h1>
    <p class="round-note">${esc(g.roundNote)}</p>
  </div>`,

  // Quip Clash
  answer: g => `${topbar(g, true)}
    <div class="center">
      ${g.final ? `<div class="prompt big pop">${esc(g.prompt)}</div>` : ''}
      <h2 class="cue">📱 ${g.final ? 'Everyone answers this one on your phone!' : 'Answer your two prompts on your phone!'}</h2>
      <div id="progress" class="progress"></div>
    </div>`,
  vote: g => `${topbar(g, true)}
    <div class="prompt">${esc(g.prompt)}</div>
    <div class="versus">
      <div class="answer a pop">${esc(g.answers[0])}</div>
      <div class="vs">VS</div>
      <div class="answer b pop" style="animation-delay:.15s">${esc(g.answers[1])}</div>
    </div>
    <h2 class="cue">📱 Vote for the funnier answer!</h2>
    <div id="progress" class="progress small"></div>`,
  result: g => {
    const anyWinner = g.answers.some(a => a.winner);
    return `${topbar(g)}
      <div class="prompt">${esc(g.prompt)}</div>
      <div class="versus">${quipCard(g.answers[0], 0, anyWinner)}<div class="vs">VS</div>${quipCard(g.answers[1], 1, anyWinner)}</div>
      <h2 class="cue">${g.forfeit ? 'Someone ran out of time, so the other answer wins!' : '&nbsp;'}</h2>`;
  },
  finalVote: g => `${topbar(g, true)}
    <div class="prompt">${esc(g.prompt)}</div>
    <div class="final-grid">${g.options.map((o, i) => `<div class="fa" style="--d:${i}"><span class="num">${i + 1}</span>${esc(o.text)}</div>`).join('')}</div>
    <h2 class="cue">📱 Vote for your favorite!</h2>
    <div id="progress" class="progress small"></div>`,
  finalResult: g => `${topbar(g)}
    <div class="prompt">${esc(g.prompt)}</div>
    <div class="final-grid results">${g.results.map((r, i) => `<div class="fa ${r.voters.length && r.voters.length === g.results[0].voters.length ? 'win' : ''}" style="--d:${i}">
      <div class="text">${esc(r.text)}</div>
      <div class="fa-foot">
        <span class="by">${av(r.author)} ${esc(r.author.name)}</span>
        <span class="votes">${r.voters.map((v, j) => av(v, '', j)).join('')}</span>
        <span class="pts">+${r.points.toLocaleString()}</span>
      </div>
    </div>`).join('')}</div>`,

  // Bluff
  write: g => `${topbar(g, true)}
    <div class="center">
      <div class="question big pop">${fmtQ(g.question)}</div>
      <h2 class="cue">📱 Write a believable lie on your phone!</h2>
      <div id="progress" class="progress"></div>
    </div>`,
  pick: g => `${topbar(g, true)}
    <div class="question">${fmtQ(g.question)}</div>
    <div class="options">${g.options.map((o, i) => `<div class="opt pop" style="animation-delay:${i * 60}ms">${esc(o.text)}</div>`).join('')}</div>
    <h2 class="cue">📱 Which one is the TRUTH?</h2>
    <div id="progress" class="progress small"></div>`,
  reveal: g => `${topbar(g)}
    <div class="question">${fmtQ(g.question)}</div>
    <div id="stage" class="stage"></div>`,

  // Story Chain
  chain: g => `${topbar(g, true)}
    <div class="center">
      <div class="dots">${Array.from({ length: g.lines }, (_, i) => `<span class="${i < g.turn ? 'on' : ''}"></span>`).join('')}</div>
      <h2 class="cue">📱 ${g.turn === 1 ? 'Start your story on your phone!' : g.turn === g.lines ? 'Write the ENDING on your phone!' : 'Write the next line on your phone!'}</h2>
      <p class="round-note">You only get to see the line right before yours 🤫</p>
      <div id="progress" class="progress"></div>
    </div>`,
  read: g => `${topbar(g, false, `<span class="reader-cue">${readerCue(g)}</span>`)}
    <div class="storybook">
      <div class="story-line opener ${g.lineIdx === 0 ? 'enter' : ''}">${esc(g.opener)}</div>
      ${g.shown.map((l, i) => `<div class="story-line ${i === g.lineIdx ? 'current enter' : ''}">
        <span class="sl-by">${l.author ? av(l.author, 'sm') : '<span class="narrator" title="Narrator">📖</span>'}</span>
        <span class="sl-text">${esc(l.text)}</span>
      </div>`).join('')}
    </div>
    ${g.theEnd ? '<div class="the-end">THE END</div>' : ''}`,
  storyVote: g => `${topbar(g, true)}
    <div class="final-grid stories">${g.options.map((o, i) => storyCard(o, i)).join('')}</div>
    <h2 class="cue">📱 Vote for the best story! (Not one you helped write.)</h2>
    <div id="progress" class="progress small"></div>`,
  storyResult: g => {
    const best = g.results[0]?.voters.length || 0;
    return `${topbar(g)}
      <h2 class="cue">🏆 The votes are in! ✍️ = who wrote it · 🗳️ = who voted for it</h2>
      <div class="final-grid results stories">${g.results.map((r, i) => storyCard({ ...r, win: best && r.voters.length === best }, i, `
        <div class="fa-foot">
          <span class="by">✍️ ${r.authors.map(a => av(a)).join('')}</span>
          <span class="votes">${r.voters.length ? `🗳️ ${r.voters.map((v, j) => av(v, '', j)).join('')}` : ''}</span>
          <span class="pts">+${r.points.toLocaleString()}</span>
        </div>`)).join('')}</div>`;
  },

  scores: g => standings(g, false),
  end: g => standings(g, true),
};

// Bluff reveal: walk through each answer people picked, ending on the truth.
function liveReveal(g) {
  const stage = $('#stage');
  if (!stage || !g.steps.length) return;
  const elapsed = serverNow() - g.phaseStart;
  const raw = Math.floor(elapsed / g.stepMs);
  const k = Math.min(Math.max(raw, 0), g.steps.length - 1);
  const shown = raw > k || elapsed - k * g.stepMs > 1500;
  const key = `${k}:${shown}`;
  if (key === stageKey) return;
  const isNewStep = !stageKey.startsWith(`${k}:`);
  stageKey = key;
  const st = g.steps[k];
  const truth = st.kind === 'truth';
  let html = `<div class="reveal-opt ${isNewStep ? 'enter' : ''} ${truth && shown ? 'truth' : ''}">${esc(st.text)}</div>`;
  if (st.pickers.length) {
    const what = truth && shown ? `found it! <b>+${st.points.toLocaleString()}</b>` : 'picked this…';
    html += `<div class="fell">${st.pickers.map((p, i) => av(p, '', i)).join('')}<span>${names(st.pickers)} ${what}</span></div>`;
  }
  if (shown) {
    if (truth) {
      html += '<div class="truth-label">✅ THE TRUTH!</div>';
      if (!st.pickers.length) html += '<div class="fell"><span>Nobody found the truth! 😱</span></div>';
    } else if (st.kind === 'house') {
      html += '<div class="who">It’s a LIE! That one was ours 😜</div>';
    } else {
      const pts = (st.points * st.pickers.length).toLocaleString();
      html += `<div class="who">It’s a LIE! ${st.authors.map(a => av(a)).join('')} ${names(st.authors)} wrote it <b>+${pts}</b></div>`;
    }
    if (truth) sfx.ding(); else sfx.boop();
  }
  stage.innerHTML = html;
}

// ---------- controls ----------

let endArmed = null;
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.start) return hostAct({ type: 'start', game: b.dataset.start });
  if (b.dataset.kick) return hostAct({ type: 'kick', pid: b.dataset.kick });
  if (b.dataset.host) return hostAct({ type: b.dataset.host });
  if (b.id === 'end-game') {
    // Two clicks so nobody ends the game by accident.
    if (endArmed) { clearTimeout(endArmed); endArmed = null; b.classList.remove('armed'); b.textContent = 'End game'; return hostAct({ type: 'end' }); }
    b.classList.add('armed');
    b.textContent = 'Click again to end';
    endArmed = setTimeout(() => { endArmed = null; b.classList.remove('armed'); b.textContent = 'End game'; }, 3000);
    return;
  }
  if (b.id === 'new-room') {
    // A new code means everyone has to rejoin, so this also takes two clicks.
    if (b.dataset.armed) {
      try { sessionStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
      window.removeEventListener('pagehide', saveNow);
      return location.reload();
    }
    b.dataset.armed = '1';
    b.textContent = 'Click again: everyone will need to rejoin';
    setTimeout(() => { delete b.dataset.armed; b.textContent = 'Use a new room code'; }, 3000);
    return;
  }
  if (b.id === 'mute') {
    muted = !muted;
    store.set('muted', muted ? '1' : '0');
    b.textContent = muted ? '🔇' : '🔊';
    return;
  }
  if (b.id === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
});
$('#mute').textContent = muted ? '🔇' : '🔊';

function hostAct(body) {
  const r = engine.host(body);
  if (!r.ok) toast(r.error);
}

// Keep the laptop screen from going to sleep mid-game.
let wake = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch { /* not supported or denied */ }
}
document.addEventListener('pointerdown', keepAwake);
document.addEventListener('visibilitychange', keepAwake);

// ---------- sound ----------

const sfx = (() => {
  let ctx = null;
  document.addEventListener('pointerdown', () => {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume?.();
    } catch { /* no audio */ }
  });
  function tone(freq, dur, { type = 'sine', vol = 0.12, at = 0 } = {}) {
    if (muted || !ctx) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  return {
    tick: () => tone(880, 0.07, { type: 'square', vol: 0.04 }),
    blip: () => { tone(523, 0.12); tone(784, 0.16, { at: 0.1 }); },
    boop: () => tone(196, 0.3, { type: 'triangle', vol: 0.16 }),
    ding: () => { tone(784, 0.2); tone(1047, 0.4, { at: 0.12 }); },
    fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.28, { at: i * 0.12, type: 'triangle' })),
  };
})();

function phaseSound(phase) {
  if (WAITING.has(phase)) sfx.blip();
  else if (phase === 'result' || phase === 'finalResult' || phase === 'storyResult') sfx.ding();
  else if (phase === 'intro' || phase === 'scores' || phase === 'end') sfx.fanfare();
}

everyTick(() => {
  const g = S?.game;
  if (!g) return;
  if (g.phase === 'reveal') liveReveal(g);
  if (g.deadline && WAITING.has(g.phase)) {
    const secs = Math.ceil((g.deadline - serverNow()) / 1000);
    if (secs !== lastTickSec) {
      lastTickSec = secs;
      if (secs > 0 && secs <= 5) sfx.tick();
    }
  }
});

// ---------- start up ----------

// A refresh of the TV page picks the room back up (same code, same scores).
const saved = loadSaved();
if (saved) engine.load(saved.snapshot);
openRoom(saved?.roomCode || genRoomCode(), !!saved);
engine.start();
pushState();
