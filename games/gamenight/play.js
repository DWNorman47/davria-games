// Phone controller: find the room, join, answer prompts, write lies, vote.
// The TV (tv.html) hosts the game; this page talks to it over PeerJS.

const app = $('#app');

let roomCode = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
let pid = null;
let S = null;
let shownKey = '';
let busy = false;
let chosenAvatar = null;
let avatarList = [];

let peer = null;
let hostConn = null;
let lastBeat = 0;
let reconnectTimer = null;
const pending = new Map(); // request id -> resolve()
let reqSeq = 0;

const pidKey = () => `gamenight-pid-${roomCode}`;

if (roomCode.length >= 4) connectRoom();
else showLanding();

// ---------- finding the room ----------

function showLanding(msg = '') {
  shownKey = 'landing';
  S = null;
  // Stop any reconnect attempt that was queued before we got here.
  clearTimeout(reconnectTimer);
  setOnline(true);
  hostConn = null;
  try { peer?.destroy(); } catch { /* already gone */ }
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  app.innerHTML = `<div class="join">
    <a class="back-link" href="../../index.html">← Game Arcade</a>
    <h1 class="brand-title">Game Night</h1>
    <div class="card">
      <label for="code">Room code (it’s on the TV)</label>
      <input id="code" class="code-input" type="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="ABC123" value="${esc(roomCode || store.get('gamenight-last-room') || '')}">
      <button id="go" class="btn big">Join the room</button>
      <p class="err" id="err">${esc(msg)}</p>
    </div>
    <div class="card center">
      <h2>📺 Hosting?</h2>
      <p class="muted">Open Game Night on the TV (or a laptop hooked up to it). Everyone else joins from their phone.</p>
      <a class="btn alt" href="tv.html">Open the TV screen</a>
    </div>
  </div>`;
}

function goToRoom() {
  const code = normalizeRoomCode($('#code').value);
  if (code.length < 4) { $('#err').textContent = 'Type the room code from the TV.'; return; }
  roomCode = code;
  try { history.replaceState(null, '', `?room=${code}`); } catch { /* ignore */ }
  connectRoom();
}

function connectRoom() {
  clearTimeout(reconnectTimer);
  pid = store.get(pidKey());
  if (!S) {
    shownKey = 'connecting';
    app.innerHTML = `<div class="card center"><div class="big-emoji">📡</div><h2>Connecting to room ${esc(roomCode)}…</h2></div>`;
  }
  try { peer?.destroy(); } catch { /* already gone */ }
  hostConn = null;
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    const c = peer.connect(PEER_PREFIX + roomCode, { reliable: true });
    hostConn = c;
    c.on('open', () => {
      lastBeat = Date.now();
      setOnline(true);
      store.set('gamenight-last-room', roomCode);
      c.send(pid ? { type: 'join', pid } : { type: 'hello' });
    });
    c.on('data', onHostMessage);
    c.on('close', () => { if (hostConn === c) lostHost(); });
    c.on('error', () => { if (hostConn === c) lostHost(); });
  });
  peer.on('error', err => {
    // A wrong code on the first try goes back to the code screen; mid-game, keep trying.
    if (err.type === 'peer-unavailable' && !S && shownKey !== 'join') {
      return showLanding(`Couldn’t find room ${roomCode}. Check the code on the TV.`);
    }
    // The matchmaking server dropping out doesn't affect an open link to the TV.
    if (hostConn?.open && ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)) return;
    lostHost();
  });
}

function lostHost() {
  if (shownKey === 'landing') return;
  setOnline(false, 'Lost the TV. Reconnecting…');
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectRoom, 2500);
}

// Phones that sleep often wake up with a dead connection.
setInterval(() => {
  if (hostConn && shownKey !== 'landing' && Date.now() - lastBeat > HEARTBEAT_TIMEOUT_MS) {
    hostConn = null;
    lostHost();
  }
}, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && hostConn && Date.now() - lastBeat > HEARTBEAT_INTERVAL_MS * 2) {
    hostConn = null;
    lostHost();
  }
});

function sendHost(msg) {
  try { if (hostConn?.open) { hostConn.send(msg); return true; } } catch { /* closing */ }
  return false;
}

function onHostMessage(msg) {
  lastBeat = Date.now();
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ping':
      return sendHost({ type: 'pong' });
    case 'avatars':
      avatarList = msg.avatars || [];
      if (shownKey === 'join') renderAvatars();
      else if (!pid) showJoin();
      return;
    case 'joined':
      pid = msg.pid;
      store.set(pidKey(), pid);
      return;
    case 'reject':
      avatarList = msg.avatars || avatarList;
      if (msg.reason === 'reset') { forget(); return showJoin(); }
      if (shownKey !== 'join') showJoin();
      busy = false;
      $('#join').disabled = false;
      $('#err').textContent = msg.reason;
      renderAvatars();
      return;
    case 'kicked':
      forget();
      sendHost({ type: 'hello' }); // fresh animal list for the join screen
      return showJoin('You were removed from the game. Join again?');
    case 'state':
      if (!msg.view) return;
      S = msg.view;
      clockSkew = S.now - Date.now();
      busy = false;
      return render();
    case 'result':
      pending.get(msg.reqId)?.(msg);
      pending.delete(msg.reqId);
      return;
  }
}

function forget() {
  pid = null;
  S = null;
  store.del(pidKey());
}

// Ask the TV to do something and wait for its answer.
function request(body) {
  return new Promise(resolve => {
    const reqId = ++reqSeq;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ ok: false, error: 'The TV didn’t answer. Try again.' });
    }, 8000);
    pending.set(reqId, r => { clearTimeout(timer); resolve(r); });
    if (!sendHost({ type: 'act', reqId, body })) {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve({ ok: false, error: 'Not connected to the TV right now. Hang on…' });
    }
  });
}

// ---------- joining ----------

function showJoin(msg = '') {
  shownKey = 'join';
  busy = false;
  app.innerHTML = `<div class="join">
    <h1 class="brand-title">Game Night</h1>
    <div class="card">
      <span class="tag">Room ${esc(roomCode)}</span>
      <label for="name">Your name</label>
      <input id="name" type="text" maxlength="14" autocomplete="off" autocapitalize="words" enterkeyhint="go" placeholder="Your name" value="${esc(store.get('name') || '')}">
      <label>Pick your animal</label>
      <div id="avatars" class="avatars"></div>
      <button id="join" class="btn big">Join the game!</button>
      <p class="err" id="err">${esc(msg)}</p>
    </div>
  </div>`;
  renderAvatars();
}

// Keep the animal picker fresh while people are joining at the same time.
setInterval(() => { if (shownKey === 'join' && !busy) sendHost({ type: 'hello' }); }, 3000);

function renderAvatars() {
  const free = avatarList.filter(x => !x.taken).map(x => x.a);
  if (!free.includes(chosenAvatar)) chosenAvatar = free[Math.floor(Math.random() * free.length)] || null;
  const box = $('#avatars');
  if (!box) return;
  box.innerHTML = avatarList.map(x => `<button type="button" data-av="${esc(x.a)}" ${x.taken ? 'disabled' : ''} class="${x.a === chosenAvatar ? 'sel' : ''}">${esc(x.a)}</button>`).join('');
}

function join() {
  const input = $('#name');
  const name = input.value.trim();
  if (!name) { $('#err').textContent = 'Type your name first!'; input.focus(); return; }
  if (busy) return;
  if (!sendHost({ type: 'join', name, avatar: chosenAvatar })) {
    $('#err').textContent = 'Not connected to the TV right now. Hang on…';
    return;
  }
  busy = true;
  $('#join').disabled = true;
  store.set('name', name);
}

// ---------- screens ----------

function keyFor(g) {
  if (!g) return 'lobby';
  const base = [g.type, g.phase, g.phaseStart].join('|');
  switch (g.phase) {
    case 'answer': return `${base}|${g.isParticipant ? (g.todo[0]?.key ?? 'done') : 'late'}`;
    case 'vote': return `${base}|${g.isAuthor}|${g.myVote}`;
    case 'finalVote': return `${base}|${g.myVote}`;
    case 'write': return `${base}|${g.myLie != null}`;
    case 'pick': return `${base}|${g.myPick}`;
    case 'chain': return `${base}|${g.isWriter}|${g.myLine != null}`;
    case 'storyVote': return `${base}|${g.myVote}`;
    default: return base;
  }
}

function render() {
  if (!S) return;
  const g = S.game;
  const key = keyFor(g);
  if (key !== shownKey) {
    shownKey = key;
    app.innerHTML = header() + body(g);
    const txt = $('#txt');
    if (txt) txt.focus({ preventScroll: true });
  }
  syncTimers(g?.deadline ?? null);
  // Don't spoil a Bluff reveal: hold back this question's points until the TV shows them.
  const hidden = g?.phase === 'reveal' && !$('#reveal-me')?.dataset.done ? g.myGain : 0;
  $('#my-score').textContent = `${(S.me.score - hidden).toLocaleString()} pts`;
  const others = $('#others');
  if (others) {
    const sig = S.players.map(p => p.pid).join();
    if (others.dataset.sig !== sig) {
      others.dataset.sig = sig;
      others.innerHTML = S.players.map(p => `<span class="chip">${av(p)} ${esc(p.name)}</span>`).join('');
    }
  }
  if (g?.phase === 'reveal') liveReveal(g);
}

const header = () => `<div class="me">${av(S.me)}<b>${esc(S.me.name)}</b><span class="score" id="my-score"></span></div>`;
const timerRow = () => '<div class="timer-row"><div class="timer"></div></div>';
const note = (emoji, title, sub = '') => `<div class="card center"><div class="big-emoji">${emoji}</div><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>`;
const gainCard = (pts, msg) => `<div class="card center"><div class="gain ${pts ? '' : 'zero'}">+${pts.toLocaleString()}</div><p>${msg}</p></div>`;

function body(g) {
  if (!g) {
    return `<div class="card center">
      ${av(S.me, 'xl')}
      <h2>You’re in!</h2>
      <p class="muted">Waiting for the host to start a game…</p>
      <div id="others" class="mini-roster"></div>
    </div>
    <button class="link" id="leave">Not you? Change your name</button>`;
  }
  switch (g.phase) {
    case 'intro':
      return `<div class="card center"><span class="tag">${GAME_NAMES[g.type]}</span><h1>${esc(g.roundLabel)}</h1><p>${esc(g.roundNote)}</p><p class="muted">👀 Eyes on the TV!</p></div>`;

    case 'answer': {
      if (!g.isParticipant) return note('⏳', 'You’ll get prompts next round!', 'You joined partway through. Hang tight.');
      const t = g.todo[0];
      if (!t) return note('✅', 'All done!', 'Watch the TV while everyone else finishes.');
      const label = g.final ? 'Final prompt' : `Prompt ${g.myTotal - g.todo.length + 1} of ${g.myTotal}`;
      return `${timerRow()}<div class="card">
        <span class="tag">${label}</span>
        <div class="prompt">${esc(t.prompt)}</div>
        <textarea id="txt" maxlength="80" rows="3" placeholder="Your funniest answer…" enterkeyhint="send"></textarea>
        <div class="row"><span class="muted" id="cnt">0/80</span><button class="btn" id="send">Send</button></div>
        <p class="err" id="err"></p>
      </div>`;
    }

    case 'vote':
      if (g.isAuthor) return note('🤞', 'One of these is yours!', 'Sit tight while everyone votes.');
      if (g.myVote != null) return note('🗳️', 'Vote locked in!', `You picked “${esc(g.answers[g.myVote])}”`);
      return `${timerRow()}<div class="prompt small">${esc(g.prompt)}</div>
        <p class="muted center-text">Tap the funnier answer</p>
        <button class="vote-btn a" data-vote="0">${esc(g.answers[0])}</button>
        <div class="or">or</div>
        <button class="vote-btn b" data-vote="1">${esc(g.answers[1])}</button>`;

    case 'result': {
      if (g.myGain == null) return note('📺', 'Look at the TV!');
      const mine = g.answers.find(a => a.author.pid === S.me.pid);
      return gainCard(g.myGain, mine?.sweep ? 'CLEAN SWEEP! Everyone voted for you! 🎉' : mine?.winner ? 'Your answer won! 🎉' : 'points for your answer');
    }

    case 'finalVote': {
      if (g.myVote != null) return note('🗳️', 'Vote locked in!', 'Watch the TV for the results.');
      const opts = g.options.filter(o => o.id !== g.myOptionId);
      if (!opts.length) return note('⏳', 'Waiting for votes…');
      return `${timerRow()}<div class="prompt small">${esc(g.prompt)}</div>
        <p class="muted center-text">Vote for your favorite (you can’t pick your own)</p>
        ${opts.map(o => `<button class="opt-btn plain" data-fvote="${o.id}">${esc(o.text)}</button>`).join('')}`;
    }

    case 'finalResult':
      return g.myGain == null ? note('📺', 'Look at the TV!') : gainCard(g.myGain, 'points from the final round');

    case 'write':
      if (g.myLie != null) return note('😇', 'Lie locked in!', `“${esc(g.myLie)}”<br>Now look innocent…`);
      return `${timerRow()}<div class="card">
        <span class="tag">Question ${g.qNum} of ${g.qCount}</span>
        <div class="question">${fmtQ(g.question)}</div>
        <input id="txt" type="text" maxlength="40" autocomplete="off" autocorrect="off" enterkeyhint="send" placeholder="Type a believable fake answer">
        <button class="btn big" id="send">Send my lie</button>
        <p class="err" id="err"></p>
      </div>`;

    case 'pick': {
      if (g.myPick != null) {
        const picked = g.options.find(o => o.id === g.myPick);
        return note('🔒', 'Locked in!', `You picked “${esc(picked?.text)}”`);
      }
      return `${timerRow()}<div class="question small">${fmtQ(g.question)}</div>
        <p class="muted center-text">Which one is the TRUTH?</p>
        ${g.options.map(o => (g.mineIds.includes(o.id)
          ? `<button class="opt-btn mine" disabled>${esc(o.text)}<small>your lie</small></button>`
          : `<button class="opt-btn" data-pick="${o.id}">${esc(o.text)}</button>`)).join('')}`;
    }

    case 'reveal':
      return `<div id="reveal-me">${note('📺', 'Watch the TV!', 'The truth is about to come out…')}</div>`;

    case 'chain':
      if (!g.isWriter) return note('⏳', 'You’ll write in the next game!', 'Watch the TV and enjoy the stories.');
      if (g.myLine != null) return note('✍️', 'Line sent!', 'Waiting for everyone else…');
      return `${timerRow()}<div class="card">
        <span class="tag">Story ${g.storyNum} · Line ${g.turn} of ${g.lines}</span>
        <p class="muted">${g.prevIsOpener ? 'The story starts like this:' : 'The line before yours:'}</p>
        <div class="prompt">${esc(g.prevLine)}</div>
        <p class="hint">${esc(g.hint)}</p>
        <textarea id="txt" maxlength="100" rows="3" placeholder="Write the next sentence…" enterkeyhint="send"></textarea>
        <div class="row"><span class="muted" id="cnt">0/100</span><button class="btn" id="send">Send</button></div>
        <p class="err" id="err"></p>
      </div>`;

    case 'read':
      if (!g.myTurnToRead) return note('📖', 'Story time!', g.theEnd ? 'What a story!' : 'Listen up! The TV shows whose turn it is to read.');
      return `<div class="card center">
        <span class="tag">📣 You’re up!</span>
        <h2>Read this out loud:</h2>
        ${g.readOpener ? `<div class="prompt small read-opener">${esc(g.readOpener)}</div>` : ''}
        <div class="prompt">${esc(g.readText)}</div>
        <button class="btn big" id="read-done">Done reading ➜</button>
      </div>`;

    case 'storyVote': {
      if (g.myVote != null) return note('🗳️', 'Vote locked in!', 'Watch the TV for the results.');
      const opts = g.options.filter(o => g.eligibleIds.includes(o.id));
      if (!opts.length) return note('⏳', 'Everyone’s voting…', 'You helped write every story!');
      return `${timerRow()}<p class="muted center-text">Vote for the best story (not one you helped write)</p>
        ${opts.map(o => `<button class="opt-btn plain" data-svote="${o.id}"><small>${esc(o.opener)}</small>…${esc(o.ending)}</button>`).join('')}`;
    }

    case 'storyResult':
      return g.myGain == null ? note('📺', 'Look at the TV!') : gainCard(g.myGain, 'points from votes on stories you helped write');

    case 'scores':
    case 'end': {
      const ps = S.players.slice().sort((a, b) => b.score - a.score);
      const rank = ps.findIndex(p => p.score === S.me.score) + 1;
      const end = g.phase === 'end';
      return `<div class="card center">
        <span class="tag">${end ? 'Final scores' : 'Scoreboard'}</span>
        <div class="rank">#${rank || '-'}</div>
        <p><b>${S.me.score.toLocaleString()}</b> points</p>
        <p class="muted">${end ? (rank === 1 && S.me.score > 0 ? '🏆 You won! Great game!' : 'Thanks for playing! 🎉') : 'Check the TV for everyone’s scores.'}</p>
      </div>`;
    }
  }
  return note('📺', 'Look at the TV!');
}

// Hold the personal result until the TV has finished its big reveal.
function liveReveal(g) {
  const box = $('#reveal-me');
  if (!box || box.dataset.done || serverNow() - g.phaseStart < g.steps.length * g.stepMs) return;
  box.dataset.done = '1';
  const lines = [];
  if (g.myPickKind === 'truth') lines.push('🎉 You found the truth!');
  else if (g.myPickKind === 'lie') lines.push(`😅 You fell for ${names(g.myPickAuthors)}’s lie!`);
  else if (g.myPickKind === 'house') lines.push('😅 You fell for one of our lies!');
  else lines.push('⏰ You didn’t pick in time.');
  if (g.fooled) lines.push(`🕵️ Your lie fooled ${g.fooled} ${g.fooled === 1 ? 'person' : 'people'}!`);
  box.innerHTML = gainCard(g.myGain, lines.join('<br>'));
  $('#my-score').textContent = `${S.me.score.toLocaleString()} pts`;
}
everyTick(() => { if (S?.game?.phase === 'reveal') liveReveal(S.game); });

// ---------- actions ----------

function showErr(msg) {
  const el = $('#err');
  if (el) el.textContent = msg;
  else toast(msg);
}

async function act(body, btn) {
  if (busy || !pid) return;
  busy = true;
  if (btn) btn.disabled = true;
  const r = await request(body);
  busy = false;
  if (!r.ok) {
    if (r.error === 'reset') { forget(); sendHost({ type: 'hello' }); showJoin('Please join again.'); return; }
    if (btn) btn.disabled = false;
    showErr(r.error);
  }
  // On success the TV sends the new screen right behind its answer.
}

function sendText() {
  const g = S?.game;
  const el = $('#txt');
  if (!g || !el) return;
  const text = el.value.trim();
  if (!text) { showErr('Type something first!'); return; }
  if (g.phase === 'answer' && g.todo[0]) act({ type: 'answer', key: g.todo[0].key, text }, $('#send'));
  else if (g.phase === 'write') act({ type: 'lie', text }, $('#send'));
  else if (g.phase === 'chain') act({ type: 'line', text }, $('#send'));
}

app.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.av) {
    chosenAvatar = b.dataset.av;
    for (const x of $$('#avatars button')) x.classList.toggle('sel', x === b);
  } else if (b.id === 'go') goToRoom();
  else if (b.id === 'join') join();
  else if (b.id === 'send') sendText();
  else if (b.dataset.vote) act({ type: 'vote', side: Number(b.dataset.vote) }, b);
  else if (b.dataset.fvote) act({ type: 'finalVote', id: Number(b.dataset.fvote) }, b);
  else if (b.dataset.pick) act({ type: 'pick', id: Number(b.dataset.pick) }, b);
  else if (b.dataset.svote) act({ type: 'storyVote', id: Number(b.dataset.svote) }, b);
  else if (b.id === 'read-done') act({ type: 'readDone' }, b);
  else if (b.id === 'leave') {
    await request({ type: 'leave' }); // the TV answers with "kicked", which shows the join screen
  }
});

app.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.target.id === 'txt') { e.preventDefault(); sendText(); }
  if (e.target.id === 'name') { e.preventDefault(); join(); }
  if (e.target.id === 'code') { e.preventDefault(); goToRoom(); }
});

app.addEventListener('input', e => {
  if (e.target.id !== 'txt') return;
  const cnt = $('#cnt');
  if (cnt) cnt.textContent = `${e.target.value.length}/${e.target.maxLength}`;
});
