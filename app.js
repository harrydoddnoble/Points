(function () {
  const { parseEntry, formatEntry } = PointsParser;
  const { DemoStore, GoogleTasksStore } = PointsStore;
  const { PROVIDERS, classify, summarise, aiNote, aiFromNotes } = PointsAI;

  const SCOPE = 'https://www.googleapis.com/auth/tasks';
  const CREATE_LIST = '__create__';
  const $ = (id) => document.getElementById(id);

  // ---------- Settings ----------
  const defaults = {
    children: [], mode: 'demo', clientId: '', listId: '', tickOff: true, scoreTask: true,
    ai: { provider: 'off', apiKey: '', model: '', hideNames: true },
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('points.settings')) || {};
      return { ...defaults, ...saved, ai: { ...defaults.ai, ...(saved.ai || {}) } };
    } catch { return { ...defaults, ai: { ...defaults.ai } }; }
  }
  function saveSettings() {
    try { localStorage.setItem('points.settings', JSON.stringify(settings)); } catch { /* storage blocked */ }
  }
  let settings = loadSettings();
  const aiEnabled = () => settings.ai.provider !== 'off' && !!settings.ai.apiKey;

  // ---------- Google sign-in ----------
  let token = null;
  try { token = JSON.parse(localStorage.getItem('points.token')); } catch { /* ignore */ }
  let tokenClient = null;
  let tokenClientId = null;
  let pendingToken = null;

  function tokenValid() { return token && token.expiresAt > Date.now() + 60_000; }

  function gisReady() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function wait() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (Date.now() - started > 10_000) return reject(new Error("Couldn't load Google sign-in. Check your connection."));
        setTimeout(wait, 100);
      })();
    });
  }

  // Must be called from a click so the browser allows the Google popup.
  async function connectGoogle(clientId) {
    await gisReady();
    if (!tokenClient || tokenClientId !== clientId) {
      tokenClientId = clientId;
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (resp) => {
          const p = pendingToken; pendingToken = null;
          if (resp.error) return p && p.reject(new Error(resp.error_description || resp.error));
          token = { value: resp.access_token, expiresAt: Date.now() + resp.expires_in * 1000 };
          try { localStorage.setItem('points.token', JSON.stringify(token)); } catch { /* ignore */ }
          p && p.resolve(token.value);
        },
        error_callback: (err) => {
          const p = pendingToken; pendingToken = null;
          p && p.reject(new Error(err.message || err.type || 'Sign-in was cancelled'));
        },
      });
    }
    return new Promise((resolve, reject) => {
      pendingToken = { resolve, reject };
      tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' });
    });
  }

  async function getToken() {
    if (tokenValid()) return token.value;
    const err = new Error('Please reconnect to Google');
    err.code = 'auth';
    throw err;
  }

  function signOut() {
    if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token.value, () => {});
    token = null;
    try { localStorage.removeItem('points.token'); } catch { /* ignore */ }
  }

  function makeStore() {
    if (settings.mode === 'google' && settings.listId) return new GoogleTasksStore(getToken, settings.listId);
    return new DemoStore();
  }

  // ---------- Dates ----------
  function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function startOfWeek(d) {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // Monday
    return s;
  }
  const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

  // ---------- State ----------
  let tasks = [];
  let busy = false;
  let refreshAgain = false; // a refresh was asked for while one was already running
  let lastSynced = null;

  // Keep the last good copy of the list so the scores still show when Google's
  // hour-long sign-in has run out, instead of dropping to zero.
  function saveCache() {
    try {
      localStorage.setItem('points.cache', JSON.stringify({
        mode: settings.mode, listId: settings.listId, at: lastSynced, tasks,
      }));
    } catch { /* storage blocked or full */ }
  }

  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem('points.cache'));
      if (!c || c.mode !== settings.mode || c.listId !== settings.listId) return;
      tasks = c.tasks.map((t) => ({ ...t, loggedAt: new Date(t.loggedAt) }));
      lastSynced = c.at;
    } catch { /* ignore a damaged cache */ }
  }
  let aiPausedUntil = 0; // after an AI error, don't retry on every refresh

  function showBanner(msg, action) {
    const b = $('banner');
    b.hidden = !msg;
    b.textContent = msg || '';
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      b.append(' ', btn);
    }
  }

  async function reconnect() {
    try { await connectGoogle(settings.clientId); showBanner(''); refresh(); }
    catch (e) { showBanner(e.message); }
  }

  function reconnectBanner() {
    const asOf = lastSynced
      ? ` Showing points as of ${fmtTime.format(new Date(lastSynced))}${dayKey(new Date(lastSynced)) === dayKey(new Date()) ? '' : ` on ${fmtDay.format(new Date(lastSynced))}`}, so anything added since won't show until you reconnect.`
      : '';
    showBanner(`Google sign-in has expired.${asOf}`, { label: 'Reconnect', run: reconnect });
  }

  async function refresh() {
    if (busy) { refreshAgain = true; return; }
    if (!settings.children.length) { render(); return; }
    if (settings.mode === 'google' && !settings.listId) {
      showBanner('Pick a Google Tasks list in settings.');
      render();
      return;
    }
    if (settings.mode === 'google' && !tokenValid()) { reconnectBanner(); render(); return; }
    busy = true;
    $('refresh-btn').classList.add('spin');
    const store = makeStore();
    try {
      tasks = await store.load();
      // Stamp new entries with the time we first saw them, since Google Tasks keeps no
      // creation time, and optionally tick them off so the list only shows the score.
      // Anything the rules can't read is handed to the AI helper, if it's switched on.
      const forAi = [];
      for (const t of tasks) {
        if (t.isScore || !t.title.trim()) continue;
        if (parseEntry(t.title, settings.children)) {
          if (t.stamped) continue;
          await store.markLogged(t, settings.tickOff);
          t.stamped = true;
          if (settings.tickOff) t.completed = true;
        } else if (aiFromNotes(t.notes, settings.children) === undefined) {
          forAi.push(t);
        }
      }
      let aiProblem = '';
      if (forAi.length && aiEnabled() && Date.now() > aiPausedUntil) aiProblem = await readWithAi(store, forAi);
      if (settings.mode === 'google' && settings.scoreTask) {
        const scoreTasks = tasks.filter((t) => t.isScore);
        const title = scoreTitle(computeTotals());
        await store.setScoreTask(title, scoreTasks[0]);
        for (const extra of scoreTasks.slice(1)) await store.remove(extra.id);
      }
      lastSynced = Date.now();
      saveCache();
      showBanner(aiProblem);
    } catch (e) {
      if (e.code === 'auth') reconnectBanner();
      else showBanner(e.message);
    } finally {
      busy = false;
      $('refresh-btn').classList.remove('spin');
      render();
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  // Returns an error message to show, or '' if all went well.
  async function readWithAi(store, pending) {
    try {
      for (let i = 0; i < pending.length; i += 25) {
        const batch = pending.slice(i, i + 25);
        const results = await classify(settings.ai, settings.children, batch.map((t) => ({ id: t.id, title: t.title })));
        for (const t of batch) {
          if (!results.has(t.id)) continue;
          const result = results.get(t.id);
          const line = aiNote(result);
          await store.markLogged(t, settings.tickOff && !!result, line);
          t.notes = `${line}\n${t.notes || ''}`;
          t.stamped = true;
          if (result && settings.tickOff) t.completed = true;
        }
      }
      return '';
    } catch (e) {
      if (e.code === 'auth') throw e; // Google sign-in, handled by refresh()
      aiPausedUntil = Date.now() + 10 * 60_000;
      return `AI helper couldn't read new entries (${e.message}). It will try again in 10 minutes.`;
    }
  }

  function entries() {
    const out = [];
    const unparsed = [];
    for (const t of tasks) {
      if (t.isScore) continue;
      const rules = parseEntry(t.title, settings.children);
      const p = rules || aiFromNotes(t.notes, settings.children);
      if (p) out.push({ ...p, id: t.id, at: t.loggedAt, title: t.title, ai: !rules });
      else if (t.title.trim()) unparsed.push(t);
    }
    out.sort((a, b) => b.at - a.at);
    return { list: out, unparsed };
  }

  function computeTotals() {
    const now = new Date();
    const today = dayKey(now);
    const weekStart = startOfWeek(now);
    const totals = Object.fromEntries(settings.children.map((c) => [c, { today: 0, week: 0, all: 0 }]));
    for (const e of entries().list) {
      const t = totals[e.child];
      if (!t) continue;
      t.all += e.delta;
      if (e.at >= weekStart) t.week += e.delta;
      if (dayKey(e.at) === today) t.today += e.delta;
    }
    return totals;
  }

  function scoreTitle(totals) {
    const parts = settings.children.map((c) => `${c} ${totals[c].today}`);
    return `⭐ Today's score: ${parts.join(', ')}`;
  }

  // ---------- Rendering ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  }

  function entryRow(e, showTime = true) {
    return el('li', { class: 'entry' },
      el('span', { class: `delta ${e.delta >= 0 ? 'pos' : 'neg'}` }, signed(e.delta)),
      el('span', { class: 'entry-main' },
        el('strong', {}, e.child),
        el('span', { class: e.reason ? 'reason' : 'reason none' }, e.reason || 'No reason given'),
        e.ai ? el('span', { class: 'badge', title: `Read by the AI helper from “${e.title}”. Delete it if it got this wrong.` }, 'AI') : null),
      showTime ? el('span', { class: 'time subtle' }, fmtTime.format(e.at)) : null,
      el('button', { class: 'icon-btn small', title: 'Delete', 'aria-label': `Delete ${e.title}`, onclick: () => removeEntry(e.id, e.title) }, '✕'));
  }

  function render() {
    $('today-label').textContent = fmtDay.format(new Date());
    const hasKids = settings.children.length > 0;
    $('setup').hidden = hasKids;
    $('add-card').hidden = !hasKids;
    $('log-card').hidden = !hasKids;

    // Scoreboard
    const totals = computeTotals();
    const board = $('scoreboard');
    board.replaceChildren(...settings.children.map((c, i) => {
      const t = totals[c];
      return el('article', { class: `kid kid-${i % 6}` },
        el('h2', {}, c),
        el('div', { class: 'big' }, t.today < 0 ? `−${-t.today}` : String(t.today)),
        el('div', { class: 'subtle small' }, `today · ${signed(t.week)} this week · ${signed(t.all)} total`),
        el('div', { class: 'quick' },
          el('button', { class: 'minus', onclick: () => quickAdd(c, -1), 'aria-label': `Remove a point from ${c}` }, '−1'),
          el('button', { class: 'plus', onclick: () => quickAdd(c, 1), 'aria-label': `Add a point for ${c}` }, '+1')));
    }));

    // Child picker
    const sel = $('add-child');
    const current = sel.value;
    sel.replaceChildren(...settings.children.map((c) => el('option', { value: c }, c)));
    if (settings.children.includes(current)) sel.value = current;

    // Logs
    const { list, unparsed } = entries();
    const today = dayKey(new Date());
    const todays = list.filter((e) => dayKey(e.at) === today);
    $('today-log').replaceChildren(...todays.map((e) => entryRow(e)));
    $('today-empty').hidden = todays.length > 0;

    $('summary-card').hidden = !(hasKids && aiEnabled());
    if (!$('summary-output').hasChildNodes()) renderSummary(loadSummary());

    $('unparsed-card').hidden = unparsed.length === 0;
    $('unparsed-log').replaceChildren(...unparsed.map((t) => el('li', { class: 'entry' },
      el('span', { class: 'entry-main' }, t.title),
      el('button', { class: 'icon-btn small', title: 'Delete', 'aria-label': `Delete ${t.title}`, onclick: () => removeEntry(t.id, t.title) }, '✕'))));

    // History, grouped by day
    const byDay = new Map();
    for (const e of list) {
      const k = dayKey(e.at);
      if (k === today) continue;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    $('history-card').hidden = byDay.size === 0;
    $('history').replaceChildren(...[...byDay.values()].map((items) => {
      const sums = settings.children.map((c) => `${c} ${signed(items.filter((e) => e.child === c).reduce((s, e) => s + e.delta, 0))}`);
      return el('details', { class: 'day' },
        el('summary', {}, el('span', {}, fmtDay.format(items[0].at)), el('span', { class: 'subtle small' }, sums.join(' · '))),
        el('ul', { class: 'log' }, ...items.map((e) => entryRow(e))));
    }));
  }

  // ---------- AI summary ----------
  const PERIODS = { today: 'today', week: 'the last 7 days', month: 'the last 30 days' };

  function loadSummary() {
    try { return JSON.parse(localStorage.getItem('points.summary')); } catch { return null; }
  }

  function renderSummary(saved) {
    const out = $('summary-output');
    if (!saved || !saved.data) { out.replaceChildren(); return; }
    const { data } = saved;
    const list = (label, items) => (items && items.length
      ? [el('div', { class: 'label' }, label), el('ul', {}, ...items.map((i) => el('li', {}, i)))]
      : []);
    out.replaceChildren(
      el('p', { class: 'subtle small' }, `Covering ${PERIODS[saved.period] || saved.period}, written ${fmtDay.format(new Date(saved.at))} at ${fmtTime.format(new Date(saved.at))}.`),
      el('p', {}, data.overview),
      ...data.children.map((c) => el('div', { class: 'kid-summary' },
        el('h3', {}, c.child),
        el('p', {}, c.headline),
        ...list('Going well', c.goingWell),
        ...list('To work on', c.toWorkOn),
        c.tryThis ? el('div', { class: 'label' }, 'Something to try') : null,
        c.tryThis ? el('p', {}, c.tryThis) : null)));
  }

  $('summary-btn').addEventListener('click', async () => {
    const btn = $('summary-btn');
    const period = $('summary-period').value;
    const now = new Date();
    const since = period === 'today'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : new Date(now - (period === 'week' ? 7 : 30) * 86_400_000);
    const list = entries().list.filter((e) => e.at >= since);
    btn.disabled = true;
    btn.textContent = 'Writing…';
    try {
      const data = await summarise(settings.ai, settings.children, list, PERIODS[period]);
      const saved = { period, at: Date.now(), data };
      try { localStorage.setItem('points.summary', JSON.stringify(saved)); } catch { /* ignore */ }
      renderSummary(saved);
    } catch (e) {
      $('summary-output').replaceChildren(el('p', { class: 'subtle' }, `Couldn't write a summary: ${e.message}`));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Write summary';
    }
  });

  // ---------- Actions ----------
  async function addEntry(child, delta, reason) {
    try {
      await makeStore().add(formatEntry(child, delta, reason));
      await refresh();
    } catch (e) {
      if (e.code === 'auth') reconnectBanner(); else showBanner(e.message);
    }
  }

  function quickAdd(child, delta) { addEntry(child, delta, ''); }

  async function removeEntry(id, title) {
    if (!confirm(`Delete “${title}”?`)) return;
    try {
      await makeStore().remove(id);
      tasks = tasks.filter((t) => t.id !== id);
      render();
      refresh();
    } catch (e) {
      if (e.code === 'auth') reconnectBanner(); else showBanner(e.message);
    }
  }

  let submitSign = 1;
  for (const btn of document.querySelectorAll('#add-form button[type=submit]')) {
    btn.addEventListener('click', () => { submitSign = Number(btn.dataset.sign); });
  }
  $('add-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amount = Math.max(1, parseInt($('add-amount').value, 10) || 1);
    addEntry($('add-child').value, submitSign * amount, $('add-reason').value.trim());
    $('add-reason').value = '';
    $('add-amount').value = 1;
  });

  // ---------- Settings dialog ----------
  const dialog = $('settings');

  function syncModeUI() {
    const mode = dialog.querySelector('input[name=mode]:checked').value;
    $('google-settings').hidden = mode !== 'google';
  }

  const AI_PRIVACY = {
    claude: 'Get a key at console.anthropic.com. Anthropic doesn\'t train its models on API data by default. It\'s worth setting a monthly spend limit in the Console.',
    gemini: 'Get a key at aistudio.google.com. On the free tier, Google may use what you send to improve its products and people may review it, which is worth weighing up with children\'s information. Hiding names helps, and paid-tier data isn\'t used that way. Check Google\'s terms for your country.',
  };

  function syncAiUI() {
    const provider = $('set-ai-provider').value;
    $('ai-settings').hidden = provider === 'off';
    if (provider === 'off') return;
    $('set-ai-model').placeholder = PROVIDERS[provider].defaultModel;
    $('ai-privacy').textContent = AI_PRIVACY[provider];
  }
  $('set-ai-provider').addEventListener('change', () => {
    $('set-ai-model').value = '';
    syncAiUI();
  });

  async function populateLists(selected) {
    const sel = $('set-list');
    try {
      const lists = await GoogleTasksStore.listTaskLists(getToken);
      const options = lists.map((l) => el('option', { value: l.id }, l.title));
      if (!lists.some((l) => /^points$/i.test(l.title))) options.push(el('option', { value: CREATE_LIST }, '➕ Create a “Points” list'));
      sel.replaceChildren(...options);
      const points = lists.find((l) => /^points$/i.test(l.title));
      sel.value = selected && lists.some((l) => l.id === selected) ? selected : points ? points.id : CREATE_LIST;
    } catch (e) {
      sel.replaceChildren(el('option', { value: '' }, 'Connect first…'));
    }
  }

  function openSettings() {
    $('set-children').value = settings.children.join(', ');
    dialog.querySelector(`input[name=mode][value=${settings.mode}]`).checked = true;
    $('set-client-id').value = settings.clientId;
    $('set-tickoff').checked = settings.tickOff;
    $('set-scoretask').checked = settings.scoreTask;
    $('set-ai-provider').value = settings.ai.provider;
    $('set-ai-key').value = settings.ai.apiKey;
    $('set-ai-model').value = settings.ai.model;
    $('set-ai-hide').checked = settings.ai.hideNames;
    syncModeUI();
    syncAiUI();
    if (tokenValid()) populateLists(settings.listId);
    dialog.showModal();
  }

  for (const r of dialog.querySelectorAll('input[name=mode]')) r.addEventListener('change', syncModeUI);

  $('connect-btn').addEventListener('click', async () => {
    const clientId = $('set-client-id').value.trim();
    if (!clientId) { alert('Paste your OAuth client ID first (see the README).'); return; }
    try {
      await connectGoogle(clientId);
      await populateLists(settings.listId);
    } catch (e) { alert(e.message); }
  });

  $('signout-btn').addEventListener('click', () => {
    signOut();
    $('set-list').replaceChildren(el('option', { value: '' }, 'Connect first…'));
  });

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return;
    settings.children = [...new Set($('set-children').value.split(',').map((s) => s.trim()).filter(Boolean))];
    settings.mode = dialog.querySelector('input[name=mode]:checked').value;
    settings.clientId = $('set-client-id').value.trim();
    settings.tickOff = $('set-tickoff').checked;
    settings.scoreTask = $('set-scoretask').checked;
    const ai = {
      provider: $('set-ai-provider').value,
      apiKey: $('set-ai-key').value.trim(),
      model: $('set-ai-model').value.trim(),
      hideNames: $('set-ai-hide').checked,
    };
    if (ai.provider !== settings.ai.provider || ai.apiKey !== settings.ai.apiKey) aiPausedUntil = 0;
    settings.ai = ai;
    let listId = $('set-list').value;
    if (settings.mode === 'google' && listId === CREATE_LIST) {
      try { listId = (await GoogleTasksStore.createTaskList(getToken, 'Points')).id; }
      catch (e) { showBanner(e.message); listId = ''; }
    }
    if (settings.mode === 'google') settings.listId = listId;
    saveSettings();
    refresh();
  });

  $('settings-btn').addEventListener('click', openSettings);
  $('setup-open-settings').addEventListener('click', openSettings);
  // A tap on refresh counts as a click, so the browser lets us reopen Google sign-in.
  $('refresh-btn').addEventListener('click', () => {
    if (settings.mode === 'google' && settings.listId && !tokenValid()) reconnect();
    else refresh();
  });

  // Pick up entries added by voice whenever the app comes back into view, and every minute.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);

  loadCache();
  render();
  refresh();
})();
