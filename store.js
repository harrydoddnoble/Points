// Storage backends. Both expose the same shape:
//   load()               -> [{ id, title, notes, loggedAt: Date, completed }]
//   add(title)           -> creates an entry
//   remove(id)           -> deletes an entry
//   markLogged(task, tickOff, extraLine)
//                        -> records when an entry was first seen (plus any AI reading)
//                           and optionally ticks it off
//   setScoreTask(title)  -> keeps a single "today's score" task up to date
(function (root) {
  const LOGGED_RE = /Points app: logged (\d{4}-\d\d-\d\dT[\d:.]+Z)/;
  const SCORE_MARKER = 'points-app:score';

  function loggedAtFromNotes(notes) {
    const m = notes && notes.match(LOGGED_RE);
    return m ? new Date(m[1]) : null;
  }

  function loggedNote(date, existing) {
    const line = `Points app: logged ${date.toISOString()}`;
    return existing ? `${line}\n${existing}` : line;
  }

  function notesFor(task, extraLine) {
    const withExtra = [extraLine, task.notes].filter(Boolean).join('\n');
    return task.stamped ? withExtra : loggedNote(task.loggedAt, withExtra);
  }

  // ---------- Demo backend (this browser only) ----------
  class DemoStore {
    constructor() { this.key = 'points.demo.tasks'; }
    _read() {
      try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; }
    }
    _write(tasks) {
      try { localStorage.setItem(this.key, JSON.stringify(tasks)); } catch { /* storage blocked */ }
    }
    async load() {
      return this._read().map((t) => {
        const loggedAt = loggedAtFromNotes(t.notes);
        return { ...t, loggedAt: loggedAt || new Date(), stamped: !!loggedAt, isScore: t.notes === SCORE_MARKER };
      });
    }
    async add(title) {
      const tasks = this._read();
      tasks.push({ id: crypto.randomUUID(), title, notes: loggedNote(new Date()), completed: true });
      this._write(tasks);
    }
    async remove(id) { this._write(this._read().filter((t) => t.id !== id)); }
    async markLogged(task, tickOff, extraLine) {
      const tasks = this._read();
      const t = tasks.find((x) => x.id === task.id);
      if (t) { t.notes = notesFor(task, extraLine); if (tickOff) t.completed = true; }
      this._write(tasks);
    }
    async setScoreTask() { /* nothing to sync to in demo mode */ }
  }

  // ---------- Google Tasks backend ----------
  const API = 'https://tasks.googleapis.com/tasks/v1';

  class GoogleTasksStore {
    constructor(getToken, listId) {
      this.getToken = getToken;
      this.listId = listId;
    }

    async _fetch(path, options = {}) {
      const token = await this.getToken();
      const res = await fetch(API + path, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      if (res.status === 401) {
        const err = new Error('Google sign-in has expired');
        err.code = 'auth';
        throw err;
      }
      if (!res.ok) throw new Error(`Google Tasks error ${res.status}: ${await res.text()}`);
      return res.status === 204 ? null : res.json();
    }

    static async listTaskLists(getToken) {
      const store = new GoogleTasksStore(getToken, null);
      const data = await store._fetch('/users/@me/lists?maxResults=100');
      return data.items || [];
    }

    static async createTaskList(getToken, title) {
      const store = new GoogleTasksStore(getToken, null);
      return store._fetch('/users/@me/lists', { method: 'POST', body: JSON.stringify({ title }) });
    }

    _list() { return `/lists/${encodeURIComponent(this.listId)}/tasks`; }

    async load() {
      const out = [];
      let pageToken = '';
      do {
        const q = `?showCompleted=true&showHidden=true&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`;
        const data = await this._fetch(this._list() + q);
        for (const t of data.items || []) {
          if (t.deleted) continue;
          out.push({
            id: t.id,
            title: t.title || '',
            notes: t.notes || '',
            completed: t.status === 'completed',
            // Google Tasks has no "created" time, so until we stamp a task we use its last
            // update time, which is the creation time for a task nobody has touched yet.
            loggedAt: loggedAtFromNotes(t.notes) || new Date(t.updated),
            stamped: !!loggedAtFromNotes(t.notes),
            isScore: (t.notes || '').includes(SCORE_MARKER),
          });
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return out;
    }

    async add(title) {
      await this._fetch(this._list(), {
        method: 'POST',
        body: JSON.stringify({ title, notes: loggedNote(new Date()), status: 'completed' }),
      });
    }

    async remove(id) {
      await this._fetch(`${this._list()}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async markLogged(task, tickOff, extraLine) {
      const body = { notes: notesFor(task, extraLine) };
      if (tickOff) body.status = 'completed';
      await this._fetch(`${this._list()}/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    }

    async setScoreTask(title, existing) {
      if (existing && existing.title === title) return;
      if (existing) {
        await this._fetch(`${this._list()}/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title, status: 'needsAction' }),
        });
      } else {
        await this._fetch(this._list(), { method: 'POST', body: JSON.stringify({ title, notes: SCORE_MARKER }) });
      }
    }
  }

  root.PointsStore = { DemoStore, GoogleTasksStore, SCORE_MARKER };
})(self);
