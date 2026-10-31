import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TerminalTextSanitizer,
  formatError,
  formatJson,
  sanitizeTerminalText,
  terminalFilter,
  terminalSafe,
} from './output.js';

const OSC52 = `\x1b]52;c;${Buffer.from('echo copied').toString('base64')}\x07`;
const OSC8 = '\x1b]8;;https://example.com/other\x1b\\shown text\x1b]8;;\x1b\\';
const TITLE = '\x1b]0;window title\x07';
const ERASE = '\x1b[2K\x1b[1G\x1b[1A\x1b[0K';
const C1_CSI = '\u009b2J';
const C1_OSC = '\u009d52;c;Y29waWVk\u009c';
const BIDI = 'safe\u202Etxt.exe\u202C';

const MIXED =
  `a${OSC52}b${OSC8}c${TITLE}d${ERASE}e${C1_CSI}f${C1_OSC}g${BIDI}h` +
  '\x1bPq#0;2;0;0;0\x1b\\i\x1bX sos \x1b\\j\x1b^ pm \x1b\\k\x1b_ apc \x1b\\l' +
  '\x1b(0m\x1b#8n\x1b7o\x1bcp\u0090dcs\u009cq\u0085r\x07\x08\x00s\x7f\r\nt\tu\u2028v\u2029w';
const MIXED_CLEAN = 'abshown textcdefgsafetxt.exehijklmnopqrs\nt\tuvw';

test('sanitizeTerminalText removes OSC, CSI, DCS, SOS, PM, APC and two-byte escapes whole', () => {
  assert.equal(sanitizeTerminalText(`before ${OSC52} after`), 'before  after');
  assert.equal(sanitizeTerminalText(OSC8), 'shown text');
  assert.equal(sanitizeTerminalText(`${TITLE}text`), 'text');
  assert.equal(sanitizeTerminalText(`rm -rf ~${ERASE}ls -la`), 'rm -rf ~ls -la');
  assert.equal(sanitizeTerminalText('\x1b[38;2;1;2;3mcolour\x1b[0m'), 'colour');
  assert.equal(sanitizeTerminalText('\x1bP1$r0m\x1b\\x\x1b_payload\x1b\\y'), 'xy');
  assert.equal(sanitizeTerminalText('\x1b(0lqk\x1b(B'), 'lqk');
  assert.equal(sanitizeTerminalText('\x1bc\x1b7\x1b8\x1bZ\x1b#8done'), 'done');
});

test('sanitizeTerminalText removes 8-bit C1 sequences and controls', () => {
  assert.equal(sanitizeTerminalText(`x${C1_CSI}y`), 'xy');
  assert.equal(sanitizeTerminalText(`x${C1_OSC}y`), 'xy');
  assert.equal(sanitizeTerminalText('x\u009d0;title\x07y'), 'xy');
  assert.equal(sanitizeTerminalText('x\u0090data\u009cy\u009fapc\u009cz'), 'xyz');
  assert.equal(sanitizeTerminalText('a\u0085b\u008ec\u009cd'), 'abcd');
});

test('sanitizeTerminalText removes bidi controls and Unicode line separators', () => {
  const bidi = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
  assert.equal(sanitizeTerminalText(`a${bidi}b`), 'ab');
  assert.equal(sanitizeTerminalText(BIDI), 'safetxt.exe');
  assert.equal(sanitizeTerminalText('one\u2028two\u2029three'), 'onetwothree');
});

test('sanitizeTerminalText drops other controls but keeps newlines, tabs and text', () => {
  assert.equal(sanitizeTerminalText('a\x00b\x07c\x08d\x0be\x0cf\x7fg'), 'abcdefg');
  assert.equal(sanitizeTerminalText('crlf\r\nline\rover'), 'crlf\nlineover');
  assert.equal(sanitizeTerminalText('tab\there\nnext'), 'tab\there\nnext');
  const text = 'café 日本語 👩‍💻 ‌ﻻ 🇳🇿 naïve';
  assert.equal(sanitizeTerminalText(text), text);
});

test('sanitizeTerminalText drops unterminated sequences and lets ESC end a string', () => {
  assert.equal(sanitizeTerminalText('keep\x1b]0;never closed'), 'keep');
  assert.equal(sanitizeTerminalText('keep\x1b[12'), 'keep');
  assert.equal(sanitizeTerminalText('keep\x1b'), 'keep');
  assert.equal(sanitizeTerminalText('a\x1b]0;title\x1b[31mb'), 'ab');
  assert.equal(sanitizeTerminalText('a\x1bPdcs\x07still dcs\x1b\\b'), 'ab');
  assert.equal(sanitizeTerminalText('a\x1b[1\nb'), 'a\nb');
});

test('sanitizeTerminalText handles every sequence kind together and is idempotent', () => {
  assert.equal(sanitizeTerminalText(MIXED), MIXED_CLEAN);
  assert.equal(sanitizeTerminalText(MIXED_CLEAN), MIXED_CLEAN);
});

test('TerminalTextSanitizer removes sequences split across chunks', () => {
  for (let split = 0; split <= MIXED.length; split++) {
    const sanitizer = new TerminalTextSanitizer();
    const output = sanitizer.write(MIXED.slice(0, split)) + sanitizer.write(MIXED.slice(split));
    assert.equal(output, MIXED_CLEAN, `split at ${split}`);
  }

  const sanitizer = new TerminalTextSanitizer();
  const output = [...MIXED].map((char) => sanitizer.write(char)).join('');
  assert.equal(output, MIXED_CLEAN);
});

test('terminalSafe sanitises only for terminal streams', () => {
  assert.equal(terminalSafe(`x${OSC52}${C1_CSI}${BIDI}`, { isTTY: true }), 'xsafetxt.exe');
  assert.equal(terminalSafe(`x${OSC52}`, { isTTY: false }), `x${OSC52}`);
  assert.equal(terminalSafe(`x${OSC52}`, {}), `x${OSC52}`);
  assert.equal(terminalSafe(42, { isTTY: true }), '42');
});

test('terminalFilter keeps state per stream of text and passes piped text through', () => {
  const tty = terminalFilter({ isTTY: true });
  assert.equal(tty('one \x1b]52;c;'), 'one ');
  assert.equal(tty('Zm9v\x07two \u009b'), 'two ');
  assert.equal(tty('2Jthree'), 'three');

  const piped = terminalFilter({ isTTY: false });
  assert.equal(piped('one \x1b]52;c;'), 'one \x1b]52;c;');
  assert.equal(piped('Zm9v\x07two'), 'Zm9v\x07two');
});

test('formatJson escapes C1, bidi and separator characters without changing parsed values', () => {
  const value = {
    model: `m${OSC52}${C1_OSC}${BIDI}`,
    nested: ['\u0085\u2028\u2029\u061c\u2066\x7f', { key: 'plain' }],
  };
  const json = formatJson(value);

  assert.equal(JSON.parse(json).model, value.model);
  assert.deepEqual(JSON.parse(json), value);
  assert.doesNotMatch(json, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  assert.match(json, /\\u001b\]52;c;/);
  assert.match(json, /\\u009d52;c;/);
  assert.match(json, /\\u202e/);
  assert.equal(json, JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u061c\u2028\u2029\u202e\u202c\u2066]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));

  assert.equal(formatJson({ a: '\u009b' }, 0), '{"a":"\\u009b"}');
});

test('formatError sanitises the message when stderr is a terminal', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  try {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    assert.equal(formatError(`bad request ${OSC52}${C1_OSC}\nnext`), 'Error: bad request \nnext');

    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    assert.equal(formatError(new Error(`bad ${OSC52}`)), `Error: bad ${OSC52}`);
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stderr, 'isTTY', descriptor);
    } else {
      delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  }
});
