const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntry, formatEntry } = require('../parser.js');

const kids = ['Sam', 'Ella', 'Annabel', 'Anna'];

const cases = [
  ['Sam +2 tidied his room', { child: 'Sam', delta: 2, reason: 'Tidied his room' }],
  ['Sam plus two for tidying his room', { child: 'Sam', delta: 2, reason: 'Tidying his room' }],
  ['Add 3 points to Ella for helping with dinner', { child: 'Ella', delta: 3, reason: 'Helping with dinner' }],
  ['Take 1 point from Sam because he hit his sister', { child: 'Sam', delta: -1, reason: 'He hit his sister' }],
  ['Minus two Ella shouting', { child: 'Ella', delta: -2, reason: 'Shouting' }],
  ['ella -3 rude at dinner.', { child: 'Ella', delta: -3, reason: 'Rude at dinner' }],
  ['Give Sam a point for sharing', { child: 'Sam', delta: 1, reason: 'Sharing' }],
  ['Sam +1 for kindness', { child: 'Sam', delta: 1, reason: 'Kindness' }],
  ['Give Sam to points for reading', { child: 'Sam', delta: 2, reason: 'Reading' }],
  ['Give Ella for points', { child: 'Ella', delta: 4, reason: '' }],
  ["Sam's lost 2 points for not listening", { child: 'Sam', delta: -2, reason: 'Not listening' }],
  ['Annabel plus 5 swimming badge', { child: 'Annabel', delta: 5, reason: 'Swimming badge' }],
  ['Anna earned ten points for homework', { child: 'Anna', delta: 10, reason: 'Homework' }],
  ['Add 3 to Ella tidying', { child: 'Ella', delta: 3, reason: 'Tidying' }],
  ['Points Sam lose 2 not listening', { child: 'Sam', delta: -2, reason: 'Not listening' }],
];

for (const [text, expected] of cases) {
  test(`parses "${text}"`, () => {
    assert.deepEqual(parseEntry(text, kids), expected);
  });
}

test('ignores tasks that are not points entries', () => {
  assert.equal(parseEntry('Buy milk', kids), null);
  assert.equal(parseEntry('Pick up Sam at 3', kids), null);
  assert.equal(parseEntry('Plus 2 for tidying', kids), null); // no child named
  assert.equal(parseEntry('Sam +2', []), null);
  assert.equal(parseEntry('Take Sam to football', kids), null);
  assert.equal(parseEntry('Give Ella her lunch money', kids), null);
});

test('formatEntry round-trips through parseEntry', () => {
  const title = formatEntry('Ella', -2, 'Shouting');
  assert.equal(title, 'Ella -2 Shouting');
  assert.deepEqual(parseEntry(title, kids), { child: 'Ella', delta: -2, reason: 'Shouting' });
  assert.deepEqual(parseEntry(formatEntry('Sam', 3, ''), kids), { child: 'Sam', delta: 3, reason: '' });
});
