// Optional AI helper: reads entries the rule-based parser can't, and writes summaries.
// Calls go straight from the browser to the provider with the user's own API key.
(function (root) {
  const PROVIDERS = {
    claude: { label: 'Claude (Anthropic)', defaultModel: 'claude-opus-5-5' },
    gemini: { label: 'Gemini (Google)', defaultModel: 'gemini-3.8-flash' },
  };

  // ---------- Hiding names ----------
  // With "hide names" on, each child's name is swapped for a token like [C1] before
  // anything leaves the device, and swapped back in whatever comes back.
  function makePseudonymiser(children, enabled) {
    const sorted = children.map((name, i) => ({ name, token: `[C${i + 1}]` }))
      .sort((a, b) => b.name.length - a.name.length);
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      label: (name) => (enabled ? sorted.find((c) => c.name === name).token : name),
      hide(text) {
        if (!enabled) return text;
        return sorted.reduce((s, c) => s.replace(new RegExp(`\\b${escape(c.name)}\\b`, 'gi'), c.token), text);
      },
      reveal(text) {
        if (!enabled || typeof text !== 'string') return text;
        return sorted.reduce((s, c) => s.split(c.token).join(c.name), text);
      },
      childFor(label) {
        if (!label) return null;
        const hit = sorted.find((c) => (enabled ? c.token === label || c.token === `[${label}]` : c.name.toLowerCase() === String(label).toLowerCase()));
        return hit ? hit.name : null;
      },
    };
  }

  // ---------- Provider calls ----------
  async function callClaude({ apiKey, model }, system, user, schema, effort) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for calls made directly from a web page.
        'anthropic-dangerous-direct-browser-access': 'true',
        // If the model declines, let the API retry on a suitable fallback model.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system,
        fallbacks: 'default',
        output_config: { effort, format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: user }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude error ${res.status}: ${data.error?.message || res.statusText}`);
    if (data.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    if (data.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing.');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  async function callGemini({ apiKey, model }, system, user, schema) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: `${user}\n\nReply with JSON matching this schema:\n${JSON.stringify(schema)}` }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${data.error?.message || res.statusText}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini returned an empty answer.');
    return JSON.parse(text);
  }

  function call(config, system, user, schema, effort) {
    const cfg = { ...config, model: config.model || PROVIDERS[config.provider].defaultModel };
    if (config.provider === 'claude') return callClaude(cfg, system, user, schema, effort);
    if (config.provider === 'gemini') return callGemini(cfg, system, user, schema);
    throw new Error('No AI provider selected');
  }

  // ---------- Reading entries ----------
  const CLASSIFY_SYSTEM = `You help a parent keep a points chart for their children. Each item is a short note the parent dictated to a voice assistant, usually saying that a child did something good or bad, sometimes with a number of points.

For each item decide:
- child: which child it is about, using exactly one of the labels provided. Use an empty string if no listed child is named, or if the note isn't about points or behaviour at all (for example a shopping item or an errand).
- delta: a whole number. Positive for good behaviour or when points are being given, negative for bad behaviour or when points are taken away. Use the number the parent said if there is one (allowing for speech-to-text slips such as "to" for "two" and "for" for "four"); otherwise use 1 or -1. Use 0 only when child is empty.
- reason: a short, neutral description of what happened, written in British English, without the child's label. Empty if none was given.

Be literal: don't invent details, and if a note is genuinely ambiguous about whether it is good or bad, follow the parent's wording (words like "plus", "well done", "lost", "minus").`;

  const CLASSIFY_SCHEMA = {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            child: { type: 'string' },
            delta: { type: 'integer' },
            reason: { type: 'string' },
          },
          required: ['id', 'child', 'delta', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  };

  // items: [{ id, title }] -> Map(id -> { child, delta, reason } | null)
  async function classify(config, children, items) {
    const p = makePseudonymiser(children, config.hideNames);
    const labels = children.map(p.label);
    const user = `Children: ${labels.join(', ')}\n\nItems:\n${JSON.stringify(items.map((t) => ({ id: t.id, text: p.hide(t.title) })), null, 1)}`;
    const out = await call(config, CLASSIFY_SYSTEM, user, CLASSIFY_SCHEMA, 'low');
    const results = new Map();
    for (const e of out.entries || []) {
      const child = p.childFor(e.child);
      const delta = Math.round(Number(e.delta)) || 0;
      results.set(e.id, child && delta ? { child, delta, reason: p.reveal(e.reason || '').trim() } : null);
    }
    return results;
  }

  // Results are cached in the task's notes so each entry is only sent once.
  const AI_RE = /^Points app: ai (.*)$/m;

  function aiNote(result) {
    return `Points app: ai ${result ? JSON.stringify({ c: result.child, d: result.delta, r: result.reason }) : 'none'}`;
  }

  // undefined = not checked yet, null = checked and not an entry
  function aiFromNotes(notes, children) {
    const m = notes && notes.match(AI_RE);
    if (!m) return undefined;
    if (m[1] === 'none') return null;
    try {
      const v = JSON.parse(m[1]);
      if (!children.includes(v.c)) return null;
      return { child: v.c, delta: v.d, reason: v.r || '' };
    } catch { return null; }
  }

  // ---------- Summaries ----------
  const SUMMARY_SYSTEM = `You help a parent reflect on their children's behaviour using the points chart below. Write for the parent, in warm, plain British English.

Guidelines:
- Be balanced and encouraging. Lead with what is going well, then what to work on.
- Look for patterns in the reasons and timings (for example, recurring flashpoints at bedtime or around siblings), and only describe patterns the data actually supports. With only a handful of entries, say so rather than over-reading them.
- Describe behaviours, not character: "has been struggling to stop when asked", never "is naughty" or "is lazy".
- Suggestions should be small, concrete and positive, something the parent could try tomorrow (for instance, praising the opposite behaviour or a heads-up before transitions).
- Don't diagnose, compare the children against each other, or suggest punishments.
- Refer to each child using their label exactly as given.`;

  const SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
      overview: { type: 'string' },
      children: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            child: { type: 'string' },
            headline: { type: 'string' },
            goingWell: { type: 'array', items: { type: 'string' } },
            toWorkOn: { type: 'array', items: { type: 'string' } },
            tryThis: { type: 'string' },
          },
          required: ['child', 'headline', 'goingWell', 'toWorkOn', 'tryThis'],
          additionalProperties: false,
        },
      },
    },
    required: ['overview', 'children'],
    additionalProperties: false,
  };

  // entries: [{ child, delta, reason, at: Date }]
  async function summarise(config, children, entries, periodLabel) {
    const p = makePseudonymiser(children, config.hideNames);
    const fmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const lines = entries.slice().sort((a, b) => a.at - b.at)
      .map((e) => `${fmt.format(e.at)} | ${p.label(e.child)} | ${e.delta > 0 ? '+' : ''}${e.delta} | ${p.hide(e.reason || '(no reason given)')}`);
    const user = `Period: ${periodLabel}\nChildren: ${children.map(p.label).join(', ')}\n\nEntries (time | child | points | reason):\n${lines.join('\n') || '(none)'}`;
    const out = await call(config, SUMMARY_SYSTEM, user, SUMMARY_SCHEMA, 'medium');
    return {
      overview: p.reveal(out.overview || ''),
      children: (out.children || []).map((c) => ({
        child: p.childFor(c.child) || p.reveal(c.child),
        headline: p.reveal(c.headline),
        goingWell: (c.goingWell || []).map(p.reveal),
        toWorkOn: (c.toWorkOn || []).map(p.reveal),
        tryThis: p.reveal(c.tryThis),
      })),
    };
  }

  const api = { PROVIDERS, classify, summarise, aiNote, aiFromNotes, makePseudonymiser };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointsAI = api;
})(typeof self !== 'undefined' ? self : this);
