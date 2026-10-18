// Turns free-text task titles (as dictated to Gemini / Google) into point entries.
// Examples it understands:
//   "Sam +2 tidied his room"
//   "Sam plus two for tidying his room"
//   "Add 3 points to Ella for helping with dinner"
//   "Take 1 point from Sam because he hit his sister"
//   "Minus two Ella shouting"
//   "Points Sam lose 2 not listening"
(function (root) {
  const NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, to: null, too: null, three: 3, four: 4, for: null,
    five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, fifty: 50, hundred: 100,
  };

  const NEGATIVE = ['minus', 'take', 'takeaway', 'remove', 'subtract', 'lose', 'loses', 'lost',
    'deduct', 'dock', 'negative', 'off', 'away'];
  const POSITIVE = ['plus', 'add', 'give', 'gain', 'gains', 'award', 'earn', 'earned', 'earns',
    'bonus', 'reward'];
  // Everyday verbs like "take" or "give" only count alongside a number or the word "points",
  // so "Take Sam to football" in a shared list isn't read as -1.
  const STRONG = new Set(['minus', 'plus', 'negative', 'bonus']);
  const FILLER = new Set(['to', 'from', 'points', 'point', 'pts', 'pt', 'please', 'for', 'because',
    'of', 'and', 'the', 'hey', 'google', 'note', 'log', 'record', 'reminder', 'remind', 'me', 'that']);
  const REASON_MARKERS = /\b(?:for|because(?: of)?|cause|cos|due to)\b\s+(.*)$/i;
  // "for two points" is an amount, not a reason.
  const AMOUNT_ONLY = /^\s*(?:\d+|[a-z]+)?\s*(?:points?|pts?)\s*$/i;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function capitalise(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Returns { child, delta, reason } or null if the text isn't a points entry.
  function parseEntry(text, children) {
    if (!text || !children || !children.length) return null;
    let s = ' ' + String(text).trim() + ' ';

    // Find the child (longest names first so "Annabel" wins over "Anna").
    const sorted = [...children].sort((a, b) => b.length - a.length);
    let child = null;
    for (const name of sorted) {
      const re = new RegExp("\\b" + escapeRegex(name) + "(?:'s|s')?\\b", 'i');
      if (re.test(s)) {
        child = name;
        s = s.replace(re, ' ');
        break;
      }
    }
    if (!child) return null;

    // Pull out an explicit reason ("for ...", "because ...") before looking for numbers,
    // so "for tidying 2 rooms" doesn't steal the amount. Only treat "for" as a reason
    // marker once something other than an amount follows it.
    let reason = '';
    const reasonMatch = s.match(REASON_MARKERS);
    if (reasonMatch && !AMOUNT_ONLY.test(reasonMatch[1])) {
      reason = reasonMatch[1].trim();
      s = s.slice(0, reasonMatch.index) + ' ';
    }

    let sign = 0;
    let amount = null;
    let sawKeyword = false; // plus/minus, a +/- symbol or the word "points"
    let sawVerb = false;

    // Symbolic forms: +2, -3, +  2
    const symbol = s.match(/([+\-−–])\s*(\d+)/);
    if (symbol) {
      sign = symbol[1] === '+' ? 1 : -1;
      amount = parseInt(symbol[2], 10);
      sawKeyword = true;
      s = s.replace(symbol[0], ' ');
    }

    const words = s.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
    const rest = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (NEGATIVE.includes(w) || POSITIVE.includes(w)) {
        if (!sign) sign = NEGATIVE.includes(w) ? -1 : 1;
        if (STRONG.has(w)) sawKeyword = true; else sawVerb = true;
        continue;
      }
      if (w === 'point' || w === 'points' || w === 'pts' || w === 'pt') { sawKeyword = true; continue; }
      if (amount === null && /^\d+$/.test(w)) { amount = parseInt(w, 10); continue; }
      if (amount === null && NUMBER_WORDS[w] && (w !== 'a' && w !== 'an' || /^points?$/.test(words[i + 1] || ''))) {
        amount = NUMBER_WORDS[w];
        continue;
      }
      // Speech-to-text often hears "two" as "to"/"too" and "four" as "for" right before "points".
      if (amount === null && /^(to|too|for)$/.test(w) && /^points?$/.test(words[i + 1] || '')) {
        amount = w === 'for' ? 4 : 2;
        continue;
      }
      rest.push(w);
    }

    if (!sawKeyword && !(sawVerb && amount !== null)) return null;
    if (amount === null) amount = 1;
    if (!sign) sign = 1;

    if (!reason) {
      reason = rest.filter((w) => !FILLER.has(w)).join(' ');
    }
    reason = reason.replace(/[.!]+$/, '').trim();

    return { child, delta: sign * amount, reason: capitalise(reason) };
  }

  // Canonical title written when the app itself creates an entry.
  function formatEntry(child, delta, reason) {
    const sign = delta >= 0 ? '+' : '-';
    return `${child} ${sign}${Math.abs(delta)}${reason ? ' ' + reason : ''}`;
  }

  const api = { parseEntry, formatEntry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointsParser = api;
})(typeof self !== 'undefined' ? self : this);
