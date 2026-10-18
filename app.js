(function () {
  const { parseEntry, formatEntry } = PointsParser;
  const { DemoStore, GoogleTasksStore } = PointsStore;

  const SCOPE = 'https://www.googleapis.com/auth/tasks';
  const CREATE_LIST = '__create__';
  const $ = (id) => document.getElementById(id);

  // ---------- Settings ----------
  const defaults = { children: [], mode: 'demo', clientId: '', listId: '', tickOff: true, scoreTask: true };

  function loadSettings() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('points.settings')) }; } catch { return { ...defaults }; }
  }
  function saveSettings() {
    try { localStorage.setItem('points.settings', JSON.stringify(settings)); } catch { /* storage blocked */ }
  }
  let settings = loadSettings();

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

  function reconnectBanner() {
    showBanner('Google sign-in has expired.', {
      label: 'Reconnect',
      run: async () => {
        try { await connectGoogle(settings.clientId); showBanner(''); refresh(); }
        catch (e) { showBanner(e.message); }
      },
    });
  }

  async function refresh() {
    if (busy) return;
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
      for (const t of tasks) {
        if (t.isScore || t.stamped) continue;
        if (!parseEntry(t.title, settings.children)) continue;
        await store.markLogged(t, settings.tickOff);
        t.stamped = true;
        if (settings.tickOff) t.completed = true;
      }
      if (settings.mode === 'google' && settings.scoreTask) {
        const scoreTasks = tasks.filter((t) => t.isScore);
        const title = scoreTitle(computeTotals());
        await store.setScoreTask(title, scoreTasks[0]);
        for (const extra of scoreTasks.slice(1)) await store.remove(extra.id);
      }
      showBanner('');
    } catch (e) {
      if (e.code === 'auth') reconnectBanner();
      else showBanner(e.message);
    } finally {
      busy = false;
      $('refresh-btn').classList.remove('spin');
      render();
    }
  }

  function entries() {
    const out = [];
    const unparsed = [];
    for (const t of tasks) {
      if (t.isScore) continue;
      const p = parseEntry(t.title, settings.children);
      if (p) out.push({ ...p, id: t.id, at: t.loggedAt, title: t.title });
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
        e.reason ? el('span', { class: 'reason' }, e.reason) : null),
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
    syncModeUI();
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
  $('refresh-btn').addEventListener('click', refresh);

  // Pick up entries added by voice whenever the app comes back into view, and every minute.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);

  render();
  refresh();
})();
