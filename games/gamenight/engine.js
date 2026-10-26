// Game Night rules engine: Quip Clash, Bluff and Story Chain.
// It runs inside the TV's browser (tv.html). Phones talk to it through PeerJS,
// and the TV page relays their actions here. It also loads in Node for tests.
//
//   const engine = createGameNight({ content, onUpdate, onKick });
//   engine.join({ name, avatar }) -> { ok, pid } | { ok: false, error }
//   engine.act(pid, body), engine.host(body), engine.view(pid | null)

function createGameNight({ content, onUpdate = () => {}, onKick = () => {}, speed = 1 }) {
  const { QUIP_PROMPTS, BLUFF_QUESTIONS, STORY_OPENERS, STORY_FILLERS, STORY_ENDINGS } = content;

  const MAX_PLAYERS = 16;
  const MIN_PLAYERS = 3;
  const AWAY_GRACE_MS = 20000; // a phone that dropped its connection still counts this long

  const AVATARS = ['🦊', '🐸', '🐼', '🐧', '🦁', '🐙', '🦄', '🐢', '🐝', '🐨', '🐯', '🐵', '🦉', '🐳', '🦖', '🐷', '🐰', '🦒', '🐮', '🦀'];
  const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2',
    '#f783ac', '#a9e34b', '#3bc9db', '#ff8787', '#9775fa', '#63e6be', '#ffc078', '#e599f7'];

  const T = {
    intro: 5000,
    quipAnswer: 90000,
    quipFinalAnswer: 75000,
    quipVote: 20000,
    quipResult: 8000,
    quipFinalVote: 40000,
    quipFinalResult: 15000,
    bluffWrite: 50000,
    bluffPick: 30000,
    bluffStep: 3000,
    storyWrite: 50000,
    storyLine: 25000, // fallback if the reader never taps "Done reading"
    storyFiller: 6000,
    storyEnd: 5000,
    storyVote: 45000,
    storyResult: 15000,
    scores: 10000,
    allDoneGrace: 1200,
  };
  for (const k of Object.keys(T)) T[k] = Math.round(T[k] * speed);

  const QUIP_ROUNDS = [
    { label: 'Round 1', mult: 1, note: 'You get two prompts. Write the funniest answer you can!' },
    { label: 'Round 2', mult: 2, note: 'Same idea, but every point is doubled!' },
    { label: 'Final Round', mult: 3, final: true, note: 'Everyone answers the same prompt. Triple points!' },
  ];
  const BLUFF_ROUNDS = [
    { label: 'Round 1', mult: 1, note: 'Write a fake answer good enough to fool your friends. Then find the real one!' },
    { label: 'Round 2', mult: 2, note: 'Points are doubled!' },
    { label: 'Final Question', mult: 3, note: 'Triple points. Anyone can still win!' },
  ];
  const BLUFF_PLAN = [0, 0, 0, 1, 1, 1, 2]; // round index for each question
  const STORY_ROUNDS = [
    { label: 'Story Chain', mult: 1, note: 'Write a story one line at a time. You only get to see the line before yours!' },
  ];

  // ---------- helpers ----------

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Shuffled decks so prompts don't repeat until the whole list has been used.
  const DECK_SOURCES = { quip: QUIP_PROMPTS, bluff: BLUFF_QUESTIONS, story: STORY_OPENERS };
  let decks = { quip: [], bluff: [], story: [] };
  function draw(kind) {
    if (!decks[kind].length) decks[kind] = shuffle(DECK_SOURCES[kind].slice());
    return decks[kind].pop();
  }

  function clean(s, max) {
    return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  const STOP_WORDS = new Set(['a', 'an', 'the', 'his', 'her', 'their', 'its', 'of']);
  function norm(s) {
    return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ')
      .split(' ').filter(w => w && !STOP_WORDS.has(w))
      .map(w => (w.length > 3 && !w.endsWith('ss') ? w.replace(/s$/, '') : w))
      .join(' ');
  }

  function editDistance(a, b) {
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }

  // True when a "lie" is really the truth (or a typo of it).
  function tooClose(text, q) {
    const n = norm(text);
    if (!n) return false;
    const truths = [q.a, ...(q.alts || [])].map(norm);
    if (truths.includes(n)) return true;
    const t = norm(q.a);
    if (t.length >= 4 && ` ${n} `.includes(` ${t} `)) return true;
    if (t.length >= 6 && editDistance(n, t) <= 1) return true;
    return false;
  }

  function newId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---------- room & players ----------

  const room = { players: [], game: null };

  const byId = pid => room.players.find(p => p.pid === pid && !p.gone);
  const present = () => room.players.filter(p => !p.gone);
  const isActive = p => !p.gone && (p.conns > 0 || Date.now() - p.lastSeen < AWAY_GRACE_MS);

  function pinfo(pid) {
    const p = room.players.find(x => x.pid === pid);
    return p ? { pid: p.pid, name: p.name, avatar: p.avatar, color: p.color } : { pid, name: '?', avatar: '❔', color: '#888' };
  }

  function purgeGone() {
    room.players = room.players.filter(p => !p.gone);
  }

  function addScore(pid, pts) {
    const p = room.players.find(x => x.pid === pid);
    if (p && pts) p.score += pts;
  }

  let updateQueued = false;
  function changed() {
    if (updateQueued) return;
    updateQueued = true;
    setTimeout(() => {
      updateQueued = false;
      onUpdate();
    }, 0);
  }

  function setPhase(g, phase, ms) {
    g.phase = phase;
    g.phaseStart = Date.now();
    g.deadline = ms ? Date.now() + ms : null;
    g.doneAt = null;
    changed();
  }

  function startGame(type) {
    purgeGone();
    for (const p of room.players) p.score = 0;
    GAMES[type].start();
  }

  // ---------- Quip Clash ----------

  function startQuip() {
    const g = { type: 'quip', rounds: QUIP_ROUNDS, roundIdx: -1 };
    room.game = g;
    quipNextRound(g);
  }

  function quipNextRound(g) {
    g.roundIdx++;
    if (g.roundIdx >= g.rounds.length) return setPhase(g, 'end', 0);
    const ids = shuffle(present().map(p => p.pid));
    g.participants = ids;
    if (g.rounds[g.roundIdx].final) {
      g.finalPrompt = draw('quip');
      g.finalAnswers = {};
      g.finalVotes = {};
      g.finalOptions = [];
    } else {
      // Player i shares a prompt with player i+1, so everyone gets exactly two prompts.
      g.matchups = shuffle(ids.map((pid, i) => ({
        prompt: draw('quip'),
        authors: [pid, ids[(i + 1) % ids.length]],
        answers: [null, null],
        votes: {},
      })));
      g.mi = -1;
    }
    setPhase(g, 'intro', T.intro);
  }

  function quipMyMatchups(g, pid) {
    return (g.matchups || []).map((m, i) => ({ m, i })).filter(({ m }) => m.authors.includes(pid));
  }

  function quipAnsweredAll(g, pid) {
    if (g.rounds[g.roundIdx].final) return g.finalAnswers[pid] != null;
    return quipMyMatchups(g, pid).every(({ m }) => m.answers[m.authors.indexOf(pid)] != null);
  }

  function quipNextMatchup(g) {
    while (++g.mi < g.matchups.length) {
      const m = g.matchups[g.mi];
      if (m.answers[0] == null && m.answers[1] == null) continue;
      if (m.answers[0] == null || m.answers[1] == null) return quipScoreMatchup(g); // forfeit, skip voting
      return setPhase(g, 'vote', T.quipVote);
    }
    setPhase(g, 'scores', T.scores);
  }

  function quipScoreMatchup(g) {
    const m = g.matchups[g.mi];
    const mult = g.rounds[g.roundIdx].mult;
    const counts = [0, 0];
    for (const side of Object.values(m.votes)) counts[side]++;
    const total = counts[0] + counts[1];
    const pts = [0, 0];
    let winner = null;
    let sweep = null;
    if (m.answers[0] == null || m.answers[1] == null) {
      winner = m.answers[0] == null ? 1 : 0;
      pts[winner] = 500 * mult;
      m.forfeit = true;
    } else {
      for (const s of [0, 1]) pts[s] = total ? Math.round((1000 * mult * counts[s]) / total / 10) * 10 : 0;
      if (counts[0] !== counts[1]) {
        winner = counts[0] > counts[1] ? 0 : 1;
        pts[winner] += 100 * mult;
        if (counts[1 - winner] === 0 && total >= 2) {
          sweep = winner;
          pts[winner] += 250 * mult;
        }
      }
    }
    Object.assign(m, { counts, points: pts, winner, sweep });
    addScore(m.authors[0], pts[0]);
    addScore(m.authors[1], pts[1]);
    setPhase(g, 'result', T.quipResult);
  }

  function quipStartFinalVote(g) {
    g.finalOptions = shuffle(Object.entries(g.finalAnswers).map(([pid, text]) => ({ pid, text })))
      .map((o, id) => ({ ...o, id }));
    if (!g.finalOptions.length) return setPhase(g, 'end', 0);
    setPhase(g, 'finalVote', T.quipFinalVote);
  }

  function quipScoreFinal(g) {
    const mult = g.rounds[g.roundIdx].mult;
    for (const o of g.finalOptions) {
      o.voters = Object.entries(g.finalVotes).filter(([, id]) => id === o.id).map(([pid]) => pid);
      o.points = o.voters.length * 250 * mult;
      addScore(o.pid, o.points);
    }
    setPhase(g, 'finalResult', T.quipFinalResult);
  }

  function quipVoters(g) {
    if (g.phase === 'vote') {
      const m = g.matchups[g.mi];
      return present().filter(p => !m.authors.includes(p.pid));
    }
    // final vote: anyone with at least one answer that isn't their own
    return present().filter(p => g.finalOptions.some(o => o.pid !== p.pid));
  }

  function quipAdvance(g) {
    const final = g.rounds[g.roundIdx]?.final;
    switch (g.phase) {
      case 'intro': return setPhase(g, 'answer', final ? T.quipFinalAnswer : T.quipAnswer);
      case 'answer': return final ? quipStartFinalVote(g) : quipNextMatchup(g);
      case 'vote': return quipScoreMatchup(g);
      case 'result': return quipNextMatchup(g);
      case 'scores': return quipNextRound(g);
      case 'finalVote': return quipScoreFinal(g);
      case 'finalResult': return setPhase(g, 'end', 0);
    }
  }

  function quipAllDone(g) {
    switch (g.phase) {
      case 'answer': return g.participants.map(byId).filter(p => p && isActive(p)).every(p => quipAnsweredAll(g, p.pid));
      case 'vote': return quipVoters(g).filter(isActive).every(p => g.matchups[g.mi].votes[p.pid] != null);
      case 'finalVote': return quipVoters(g).filter(isActive).every(p => g.finalVotes[p.pid] != null);
    }
    return false;
  }

  function quipAct(g, p, body) {
    if (body.type === 'answer') {
      if (g.phase !== 'answer') return 'Too late for that one!';
      const text = clean(body.text, 80);
      if (!text) return 'Write something first!';
      if (g.rounds[g.roundIdx].final) {
        if (!g.participants.includes(p.pid)) return 'You’ll jump in next game!';
        if (g.finalAnswers[p.pid] != null) return 'You already answered.';
        g.finalAnswers[p.pid] = text;
      } else {
        const m = g.matchups[Number(body.key)];
        const slot = m ? m.authors.indexOf(p.pid) : -1;
        if (slot < 0) return 'That prompt isn’t yours.';
        if (m.answers[slot] != null) return 'You already answered that one.';
        m.answers[slot] = text;
      }
      return null;
    }
    if (body.type === 'vote') {
      if (g.phase !== 'vote') return 'Voting is closed.';
      const m = g.matchups[g.mi];
      if (m.authors.includes(p.pid)) return 'You can’t vote on your own matchup.';
      if (m.votes[p.pid] != null) return 'You already voted.';
      const side = Number(body.side);
      if (side !== 0 && side !== 1) return 'Pick one of the two answers.';
      m.votes[p.pid] = side;
      return null;
    }
    if (body.type === 'finalVote') {
      if (g.phase !== 'finalVote') return 'Voting is closed.';
      const o = g.finalOptions.find(x => x.id === Number(body.id));
      if (!o) return 'Pick one of the answers.';
      if (o.pid === p.pid) return 'Nice try! You can’t vote for yourself.';
      if (g.finalVotes[p.pid] != null) return 'You already voted.';
      g.finalVotes[p.pid] = o.id;
      return null;
    }
    return 'Unknown action';
  }

  function quipView(g, me, v) {
    const final = g.rounds[g.roundIdx]?.final;
    v.final = !!final;
    if (g.phase === 'answer') {
      if (final) v.prompt = g.finalPrompt;
      v.progress = g.participants.filter(pid => byId(pid)).map(pid => ({ ...pinfo(pid), done: quipAnsweredAll(g, pid) }));
      if (me) {
        v.isParticipant = g.participants.includes(me.pid);
        if (final) {
          v.myTotal = 1;
          v.todo = v.isParticipant && g.finalAnswers[me.pid] == null ? [{ key: 'final', prompt: g.finalPrompt }] : [];
        } else {
          const mine = quipMyMatchups(g, me.pid);
          v.myTotal = mine.length;
          v.todo = mine.filter(({ m }) => m.answers[m.authors.indexOf(me.pid)] == null).map(({ m, i }) => ({ key: i, prompt: m.prompt }));
        }
      }
    }
    if (g.phase === 'vote' || g.phase === 'result') {
      const m = g.matchups[g.mi];
      v.prompt = m.prompt;
      v.matchNum = g.mi + 1;
      v.matchCount = g.matchups.length;
      if (g.phase === 'vote') {
        v.answers = m.answers.slice();
        v.progress = quipVoters(g).map(p => ({ ...pinfo(p.pid), done: m.votes[p.pid] != null }));
        if (me) {
          v.isAuthor = m.authors.includes(me.pid);
          v.myVote = m.votes[me.pid] ?? null;
        }
      } else {
        v.forfeit = !!m.forfeit;
        v.answers = [0, 1].map(s => ({
          text: m.answers[s],
          author: pinfo(m.authors[s]),
          voters: Object.entries(m.votes).filter(([, side]) => side === s).map(([pid]) => pinfo(pid)),
          points: m.points[s],
          winner: m.winner === s,
          sweep: m.sweep === s,
        }));
        if (me && m.authors.includes(me.pid)) v.myGain = m.points[m.authors.indexOf(me.pid)];
      }
    }
    if (g.phase === 'finalVote') {
      v.prompt = g.finalPrompt;
      v.options = g.finalOptions.map(o => ({ id: o.id, text: o.text }));
      v.progress = quipVoters(g).map(p => ({ ...pinfo(p.pid), done: g.finalVotes[p.pid] != null }));
      if (me) {
        v.myOptionId = g.finalOptions.find(o => o.pid === me.pid)?.id ?? null;
        v.myVote = g.finalVotes[me.pid] ?? null;
      }
    }
    if (g.phase === 'finalResult') {
      v.prompt = g.finalPrompt;
      v.results = g.finalOptions.slice().sort((a, b) => b.voters.length - a.voters.length)
        .map(o => ({ text: o.text, author: pinfo(o.pid), voters: o.voters.map(pinfo), points: o.points }));
      if (me) v.myGain = g.finalOptions.find(o => o.pid === me.pid)?.points ?? null;
    }
  }

  // ---------- Bluff ----------

  function startBluff() {
    const g = { type: 'bluff', rounds: BLUFF_ROUNDS, roundIdx: -1, qi: -1, questions: BLUFF_PLAN.map(() => draw('bluff')) };
    room.game = g;
    bluffNext(g);
  }

  function bluffNext(g) {
    g.qi++;
    if (g.qi >= g.questions.length) return setPhase(g, 'end', 0);
    const r = BLUFF_PLAN[g.qi];
    if (r !== g.roundIdx) {
      g.roundIdx = r;
      return setPhase(g, 'intro', T.intro);
    }
    bluffStartWrite(g);
  }

  function bluffStartWrite(g) {
    g.lies = {};
    g.picks = {};
    g.options = [];
    setPhase(g, 'write', T.bluffWrite);
  }

  function bluffStartPick(g) {
    const q = g.questions[g.qi];
    const groups = new Map();
    for (const [pid, text] of Object.entries(g.lies)) {
      const k = norm(text) || text;
      if (!groups.has(k)) groups.set(k, { text, authors: [], kind: 'lie' });
      groups.get(k).authors.push(pid);
    }
    const opts = [...groups.values(), { text: q.a, authors: [], kind: 'truth' }];
    for (const d of shuffle((q.decoys || []).slice())) {
      if (opts.length >= 5) break;
      if (!groups.has(norm(d))) opts.push({ text: d, authors: [], kind: 'house' });
    }
    g.options = shuffle(opts).map((o, id) => ({ ...o, id }));
    setPhase(g, 'pick', T.bluffPick);
  }

  function bluffScore(g) {
    const mult = g.rounds[g.roundIdx].mult;
    g.gain = {};
    const give = (pid, pts) => { g.gain[pid] = (g.gain[pid] || 0) + pts; addScore(pid, pts); };
    for (const o of g.options) {
      o.pickers = Object.entries(g.picks).filter(([, id]) => id === o.id).map(([pid]) => pid);
      if (o.kind === 'truth') o.pickers.forEach(pid => give(pid, 1000 * mult));
      if (o.kind === 'lie') o.authors.forEach(pid => give(pid, 500 * mult * o.pickers.length));
    }
    const fooling = g.options.filter(o => o.kind !== 'truth' && o.pickers.length)
      .sort((a, b) => a.pickers.length - b.pickers.length);
    g.steps = [...fooling, g.options.find(o => o.kind === 'truth')].map(o => o.id);
    setPhase(g, 'reveal', g.steps.length * T.bluffStep + 4000);
  }

  function bluffAdvance(g) {
    switch (g.phase) {
      case 'intro': return bluffStartWrite(g);
      case 'write': return bluffStartPick(g);
      case 'pick': return bluffScore(g);
      case 'reveal': {
        const last = g.qi === g.questions.length - 1;
        const roundOver = !last && BLUFF_PLAN[g.qi + 1] !== BLUFF_PLAN[g.qi];
        return roundOver ? setPhase(g, 'scores', T.scores) : bluffNext(g);
      }
      case 'scores': return bluffNext(g);
    }
  }

  function bluffAllDone(g) {
    const active = present().filter(isActive);
    if (g.phase === 'write') return active.every(p => g.lies[p.pid] != null);
    if (g.phase === 'pick') return active.every(p => g.picks[p.pid] != null);
    return false;
  }

  function bluffAct(g, p, body) {
    if (body.type === 'lie') {
      if (g.phase !== 'write') return 'Too late for that one!';
      if (g.lies[p.pid] != null) return 'You already sent a lie.';
      const text = clean(body.text, 40).replace(/\.+$/, '');
      if (!text) return 'Type a fake answer first!';
      if (tooClose(text, g.questions[g.qi])) return 'Whoa, that’s the real answer (or really close)! Make up a lie instead 😉';
      g.lies[p.pid] = text;
      return null;
    }
    if (body.type === 'pick') {
      if (g.phase !== 'pick') return 'Picking is closed.';
      if (g.picks[p.pid] != null) return 'You already picked.';
      const o = g.options.find(x => x.id === Number(body.id));
      if (!o) return 'Pick one of the answers.';
      if (o.authors.includes(p.pid)) return 'That’s your own lie!';
      g.picks[p.pid] = o.id;
      return null;
    }
    return 'Unknown action';
  }

  function bluffView(g, me, v) {
    const q = g.questions[g.qi];
    v.qNum = g.qi + 1;
    v.qCount = g.questions.length;
    if (['write', 'pick', 'reveal'].includes(g.phase)) v.question = q.q;
    if (g.phase === 'write') {
      v.progress = present().map(p => ({ ...pinfo(p.pid), done: g.lies[p.pid] != null }));
      if (me) v.myLie = g.lies[me.pid] ?? null;
    }
    if (g.phase === 'pick') {
      v.options = g.options.map(o => ({ id: o.id, text: o.text }));
      v.progress = present().map(p => ({ ...pinfo(p.pid), done: g.picks[p.pid] != null }));
      if (me) {
        v.mineIds = g.options.filter(o => o.authors.includes(me.pid)).map(o => o.id);
        v.myPick = g.picks[me.pid] ?? null;
      }
    }
    if (g.phase === 'reveal') {
      const mult = g.rounds[g.roundIdx].mult;
      v.answer = q.a;
      v.stepMs = T.bluffStep;
      v.steps = g.steps.map(id => {
        const o = g.options[id];
        return {
          text: o.text, kind: o.kind,
          authors: o.authors.map(pinfo), pickers: o.pickers.map(pinfo),
          points: o.kind === 'truth' ? 1000 * mult : 500 * mult,
        };
      });
      if (me) {
        const pickId = g.picks[me.pid];
        const picked = pickId != null ? g.options[pickId] : null;
        v.myPickKind = picked ? picked.kind : null;
        v.myPickAuthors = picked ? picked.authors.map(pinfo) : [];
        v.myGain = g.gain[me.pid] || 0;
        v.fooled = g.options.filter(o => o.authors.includes(me.pid)).reduce((n, o) => n + o.pickers.length, 0);
      }
    }
  }

  // ---------- Story Chain ----------

  // Aim for ~48 lines in total so the read-aloud part stays a few minutes long.
  function storyLineCount(n) {
    if (n <= 3) return 3;
    return Math.min(5, Math.max(3, Math.round(48 / n)), n - 1);
  }

  function startStory() {
    const ids = shuffle(present().map(p => p.pid));
    const g = {
      type: 'story', rounds: STORY_ROUNDS, roundIdx: 0,
      writers: ids, lines: storyLineCount(ids.length), turn: 0,
      stories: ids.map(() => ({ opener: draw('story'), lines: [] })),
      fillers: shuffle(STORY_FILLERS.slice()), endings: shuffle(STORY_ENDINGS.slice()),
      votes: {}, gain: {},
    };
    room.game = g;
    setPhase(g, 'intro', T.intro);
  }

  // On turn t, writer i adds line t to story (i + t) % n. Neighbouring lines always
  // come from different people, and nobody writes in the same story twice.
  function storyIndexFor(g, pid) {
    const i = g.writers.indexOf(pid);
    return i < 0 ? -1 : (i + g.turn) % g.writers.length;
  }

  function storyHint(g) {
    if (g.turn === g.lines - 1) return '🏁 Write the ENDING!';
    if (g.turn === g.lines - 2 && g.lines >= 4) return '🌀 Add a twist!';
    return g.turn === 0 ? 'What happens next? Get it going!' : 'What happens next?';
  }

  const storyAuthors = st => [...new Set(st.lines.map(l => l.pid).filter(Boolean))];

  function storyEndTurn(g) {
    const last = g.turn === g.lines - 1;
    for (const st of g.stories) {
      if (st.lines[g.turn]) continue;
      // Someone ran out of time: the narrator fills in.
      const pool = last ? g.endings : g.fillers;
      if (!pool.length) pool.push(...shuffle((last ? STORY_ENDINGS : STORY_FILLERS).slice()));
      st.lines[g.turn] = { pid: null, text: pool.pop() };
    }
    if (++g.turn < g.lines) return setPhase(g, 'chain', T.storyWrite);
    g.readStory = 0;
    g.readLine = 0;
    storyReadStep(g);
  }

  // Reading: one step per line (the writer reads it aloud), then a "The End" card.
  function storyReadStep(g) {
    if (g.readLine >= g.lines) return setPhase(g, 'read', T.storyEnd);
    const line = g.stories[g.readStory].lines[g.readLine];
    const reader = line.pid && byId(line.pid);
    setPhase(g, 'read', reader && isActive(reader) ? T.storyLine : T.storyFiller);
  }

  function storyNextRead(g) {
    if (++g.readLine > g.lines) { g.readStory++; g.readLine = 0; }
    if (g.readStory >= g.stories.length) return storyStartVote(g);
    storyReadStep(g);
  }

  function storyVoters(g) {
    return present().filter(p => g.stories.some(st => !storyAuthors(st).includes(p.pid)));
  }

  function storyStartVote(g) {
    if (!storyVoters(g).length) return setPhase(g, 'end', 0); // tiny games: everyone wrote every story
    setPhase(g, 'storyVote', T.storyVote);
  }

  function storyScore(g) {
    g.stories.forEach((st, id) => {
      st.voters = Object.entries(g.votes).filter(([, v]) => v === id).map(([pid]) => pid);
      st.points = st.voters.length * 250;
      for (const pid of storyAuthors(st)) {
        g.gain[pid] = (g.gain[pid] || 0) + st.points;
        addScore(pid, st.points);
      }
    });
    setPhase(g, 'storyResult', T.storyResult);
  }

  function storyAdvance(g) {
    switch (g.phase) {
      case 'intro': return setPhase(g, 'chain', T.storyWrite);
      case 'chain': return storyEndTurn(g);
      case 'read': return storyNextRead(g);
      case 'storyVote': return storyScore(g);
      case 'storyResult': return setPhase(g, 'end', 0);
    }
  }

  function storyAllDone(g) {
    if (g.phase === 'chain') {
      return g.writers.map(byId).filter(p => p && isActive(p)).every(p => g.stories[storyIndexFor(g, p.pid)].lines[g.turn]);
    }
    if (g.phase === 'storyVote') return storyVoters(g).filter(isActive).every(p => g.votes[p.pid] != null);
    return false;
  }

  function storyAct(g, p, body) {
    if (body.type === 'line') {
      if (g.phase !== 'chain') return 'Too late for that one!';
      const s = storyIndexFor(g, p.pid);
      if (s < 0) return 'You’ll get to write in the next game!';
      if (g.stories[s].lines[g.turn]) return 'You already sent your line.';
      const text = clean(body.text, 100);
      if (!text) return 'Write something first!';
      g.stories[s].lines[g.turn] = { pid: p.pid, text };
      return null;
    }
    if (body.type === 'readDone') {
      if (g.phase !== 'read' || g.readLine >= g.lines) return null; // a late double-tap; ignore it
      if (g.stories[g.readStory].lines[g.readLine].pid !== p.pid) return 'It’s someone else’s turn to read.';
      storyNextRead(g);
      return null;
    }
    if (body.type === 'storyVote') {
      if (g.phase !== 'storyVote') return 'Voting is closed.';
      const id = Number(body.id);
      const st = g.stories[id];
      if (!st) return 'Pick one of the stories.';
      if (storyAuthors(st).includes(p.pid)) return 'You helped write that one! Pick another.';
      if (g.votes[p.pid] != null) return 'You already voted.';
      g.votes[p.pid] = id;
      return null;
    }
    return 'Unknown action';
  }

  function storyView(g, me, v) {
    v.lines = g.lines;
    v.storyCount = g.stories.length;
    if (g.phase === 'chain') {
      v.turn = g.turn + 1;
      v.progress = g.writers.filter(pid => byId(pid))
        .map(pid => ({ ...pinfo(pid), done: !!g.stories[storyIndexFor(g, pid)].lines[g.turn] }));
      if (me) {
        const s = storyIndexFor(g, me.pid);
        v.isWriter = s >= 0;
        if (s >= 0) {
          const st = g.stories[s];
          Object.assign(v, {
            storyNum: s + 1,
            prevIsOpener: g.turn === 0,
            prevLine: g.turn === 0 ? st.opener : st.lines[g.turn - 1].text,
            hint: storyHint(g),
            myLine: st.lines[g.turn]?.text ?? null,
          });
        }
      }
    }
    if (g.phase === 'read') {
      const st = g.stories[g.readStory];
      const cur = st.lines[g.readLine];
      v.storyNum = g.readStory + 1;
      v.opener = st.opener;
      v.lineIdx = g.readLine;
      v.theEnd = !cur;
      v.shown = st.lines.slice(0, g.readLine + 1).map(l => ({ text: l.text, author: l.pid ? pinfo(l.pid) : null }));
      if (cur) v.reader = cur.pid ? pinfo(cur.pid) : null;
      if (me && cur?.pid === me.pid) {
        v.myTurnToRead = true;
        v.readText = cur.text;
        v.readOpener = g.readLine === 0 ? st.opener : null;
      }
    }
    const card = (st, id) => ({ id, opener: st.opener, ending: st.lines[st.lines.length - 1].text });
    if (g.phase === 'storyVote') {
      v.options = g.stories.map(card);
      v.progress = storyVoters(g).map(p => ({ ...pinfo(p.pid), done: g.votes[p.pid] != null }));
      if (me) {
        v.eligibleIds = g.stories.map((st, id) => (storyAuthors(st).includes(me.pid) ? -1 : id)).filter(id => id >= 0);
        v.myVote = g.votes[me.pid] ?? null;
      }
    }
    if (g.phase === 'storyResult') {
      v.results = g.stories
        .map((st, id) => ({ ...card(st, id), authors: storyAuthors(st).map(pinfo), voters: st.voters.map(pinfo), points: st.points }))
        .sort((a, b) => b.voters.length - a.voters.length);
      if (me && g.gain[me.pid] != null) v.myGain = g.gain[me.pid];
    }
  }

  // ---------- shared game plumbing ----------

  const GAMES = {
    quip: { start: startQuip, advance: quipAdvance, allDone: quipAllDone, act: quipAct, view: quipView },
    bluff: { start: startBluff, advance: bluffAdvance, allDone: bluffAllDone, act: bluffAct, view: bluffView },
    story: { start: startStory, advance: storyAdvance, allDone: storyAllDone, act: storyAct, view: storyView },
  };

  function advance(g) {
    if (g !== room.game || g.phase === 'end') return;
    GAMES[g.type].advance(g);
  }

  const WAITING_PHASES = new Set(['answer', 'vote', 'finalVote', 'write', 'pick', 'chain', 'storyVote']);
  function allDone(g) {
    if (!WAITING_PHASES.has(g.phase)) return false;
    return GAMES[g.type].allDone(g);
  }

  function gameView(g, me) {
    const v = { type: g.type, phase: g.phase, deadline: g.deadline, phaseStart: g.phaseStart };
    const r = g.rounds[g.roundIdx];
    if (r) Object.assign(v, { roundLabel: r.label, roundNote: r.note, mult: r.mult, roundNum: g.roundIdx + 1, roundCount: g.rounds.length });
    GAMES[g.type].view(g, me, v);
    return v;
  }

  function playersView() {
    return present().map(p => ({ ...pinfo(p.pid), score: p.score, active: isActive(p) }));
  }

  function removePlayer(p) {
    if (room.game) p.gone = true; // keep their name around for answers already on screen
    else room.players = room.players.filter(x => x !== p);
    onKick(p.pid);
    changed();
  }

  // Game clock: ends timers early once everyone is in, and notices phones dropping off.
  let clock = null;
  let lastPresence = '';
  function tick() {
    const g = room.game;
    const now = Date.now();
    if (g) {
      if (!g.doneAt && allDone(g)) {
        g.doneAt = now;
        g.deadline = Math.min(g.deadline || Infinity, now + T.allDoneGrace);
        changed();
      }
      if (g.deadline && now >= g.deadline) advance(g);
    }
    const presence = room.players.map(p => (isActive(p) ? 1 : 0)).join('');
    if (presence !== lastPresence) { lastPresence = presence; changed(); }
  }

  // ---------- public API ----------

  return {
    minPlayers: MIN_PLAYERS,

    start() { if (!clock) clock = setInterval(tick, 250); },
    stop() { clearInterval(clock); clock = null; },

    has: pid => !!byId(pid),
    playerCount: () => present().length,

    avatars() {
      const taken = new Set(present().map(p => p.avatar));
      return AVATARS.map(a => ({ a, taken: taken.has(a) }));
    },

    join(body) {
      const name = clean(body.name, 14);
      if (!name) return { ok: false, error: 'Type your name first!' };
      const same = present().find(p => p.name.toLowerCase() === name.toLowerCase());
      if (same) {
        if (!isActive(same)) return { ok: true, pid: same.pid }; // rejoining from a new phone
        return { ok: false, error: 'Someone already has that name. Try another!' };
      }
      if (present().length >= MAX_PLAYERS) return { ok: false, error: 'Sorry, the game is full.' };
      const takenAvatars = new Set(present().map(p => p.avatar));
      const avatar = AVATARS.includes(body.avatar) && !takenAvatars.has(body.avatar)
        ? body.avatar : AVATARS.find(a => !takenAvatars.has(a));
      const takenColors = new Set(present().map(p => p.color));
      const color = COLORS.find(c => !takenColors.has(c)) || COLORS[present().length % COLORS.length];
      const p = { pid: newId(), name, avatar, color, score: 0, conns: 0, lastSeen: Date.now(), gone: false };
      room.players.push(p);
      changed();
      return { ok: true, pid: p.pid };
    },

    // A phone's live connection opened or closed.
    attach(pid) {
      const p = byId(pid);
      if (!p) return;
      p.conns++;
      p.lastSeen = Date.now();
      changed();
    },
    detach(pid) {
      const p = room.players.find(x => x.pid === pid);
      if (!p) return;
      p.conns = Math.max(0, p.conns - 1);
      p.lastSeen = Date.now();
      changed();
    },

    act(pid, body) {
      const p = byId(pid);
      if (!p) return { ok: false, error: 'reset' };
      p.lastSeen = Date.now();
      if (body.type === 'leave') { removePlayer(p); return { ok: true }; }
      const g = room.game;
      if (!g) return { ok: false, error: 'The game hasn’t started yet.' };
      const error = GAMES[g.type].act(g, p, body);
      if (error) return { ok: false, error };
      changed();
      return { ok: true };
    },

    // Host controls from the TV screen.
    host(body) {
      const g = room.game;
      switch (body.type) {
        case 'start':
        case 'again': {
          const type = body.type === 'again' ? g?.type : body.game;
          if (!Object.hasOwn(GAMES, type)) return { ok: false, error: 'Pick a game.' };
          if (g && g.phase !== 'end') return { ok: false, error: 'A game is already running.' };
          if (present().length < MIN_PLAYERS) return { ok: false, error: `You need at least ${MIN_PLAYERS} players.` };
          startGame(type);
          return { ok: true };
        }
        case 'skip':
          if (g) advance(g);
          return { ok: true };
        case 'addTime':
          if (g?.deadline) { g.deadline += 30000; changed(); }
          return { ok: true };
        case 'end':
          room.game = null;
          purgeGone();
          changed();
          return { ok: true };
        case 'kick': {
          const p = byId(body.pid);
          if (!p) return { ok: false, error: 'No such player.' };
          removePlayer(p);
          return { ok: true };
        }
      }
      return { ok: false, error: 'Unknown action' };
    },

    // What one phone (pid) or the TV (null) should show right now.
    view(pid) {
      const g = room.game;
      const base = { now: Date.now(), players: playersView(), minPlayers: MIN_PLAYERS };
      if (!pid) return { ...base, role: 'host', game: g ? gameView(g, null) : null };
      const p = byId(pid);
      if (!p) return null;
      return { ...base, role: 'player', me: { ...pinfo(p.pid), score: p.score }, game: g ? gameView(g, p) : null };
    },

    // Snapshot for surviving a TV page refresh.
    save() {
      return { players: room.players.map(({ conns, ...rest }) => rest), game: room.game, decks };
    },
    load(snap) {
      room.players = (snap.players || []).map(p => ({ ...p, conns: 0, lastSeen: Date.now() }));
      room.game = snap.game || null;
      if (snap.decks) decks = snap.decks;
      changed();
    },
  };
}

if (typeof module !== 'undefined') module.exports = { createGameNight };
