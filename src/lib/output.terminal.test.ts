import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  TerminalTextSanitizer,
  formatError,
  formatJson,
  formatWarning,
  sanitizeTerminalText,
  terminalFilter,
  terminalSafe,
  terminalSafeJson,
  writeOutputText,
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

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'venice-output-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Streams backed by a regular file and by the null device, which is not one.
function withStreams<T>(run: (streams: { file: { fd: number }; device: { fd: number } }) => T): T {
  return withTempDir((dir) => {
    const file = openSync(join(dir, 'out.txt'), 'w');
    const device = openSync(devNull, 'w');
    try {
      return run({ file: { fd: file }, device: { fd: device } });
    } finally {
      closeSync(file);
      closeSync(device);
    }
  });
}

function withStderrFd<T>(fd: number, run: () => T): T {
  const descriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
    fd: Object.getOwnPropertyDescriptor(process.stderr, 'fd'),
  };
  Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stderr, 'fd', { value: fd, configurable: true });
  try {
    return run();
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        Object.defineProperty(process.stderr, name, descriptor);
      } else {
        delete (process.stderr as unknown as Record<string, unknown>)[name];
      }
    }
  }
}

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

test('terminalSafe leaves text unchanged only for a regular file', () => withStreams(({ file, device }) => {
  assert.equal(terminalSafe(`x${OSC52}${C1_CSI}${BIDI}`, { isTTY: true }), 'xsafetxt.exe');
  assert.equal(terminalSafe(`x${OSC52}${C1_CSI}${BIDI}`, device), 'xsafetxt.exe');
  assert.equal(terminalSafe(`x${OSC52}`, { isTTY: false }), 'x');
  assert.equal(terminalSafe(`x${OSC52}`, {}), 'x');
  assert.equal(terminalSafe(`x${OSC52}`, { fd: -1 }), 'x');
  assert.equal(terminalSafe(`x${OSC52}`, file), `x${OSC52}`);
  assert.equal(terminalSafe(42, { isTTY: true }), '42');
}));

test('terminalFilter keeps state per stream of text and passes text for a regular file through', () =>
  withStreams(({ file, device }) => {
    for (const stream of [{ isTTY: true }, device]) {
      const filter = terminalFilter(stream);
      assert.equal(filter('one \x1b]52;c;'), 'one ');
      assert.equal(filter('Zm9v\x07two \u009b'), 'two ');
      assert.equal(filter('2Jthree'), 'three');
    }

    const unchanged = terminalFilter(file);
    assert.equal(unchanged('one \x1b]52;c;'), 'one \x1b]52;c;');
    assert.equal(unchanged('Zm9v\x07two'), 'Zm9v\x07two');
  }));

test('writeOutputText keeps text exactly in a regular file', () => withTempDir((dir) => {
  const path = join(dir, 'out.txt');
  writeOutputText(path, MIXED);
  assert.equal(readFileSync(path, 'utf8'), MIXED);
}));

test(
  'writeOutputText sanitises text written to a pipe',
  { skip: process.platform === 'win32' },
  () => withTempDir((dir) => {
    const fifo = join(dir, 'out.fifo');
    execFileSync('mkfifo', [fifo]);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      writeOutputText(fifo, MIXED);
      assert.equal(readFileSync(reader, 'utf8'), MIXED_CLEAN);
    } finally {
      closeSync(reader);
    }
  })
);

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

test('terminalSafeJson escapes the same characters in JSON text, except for a regular file', () =>
  withStreams(({ file, device }) => {
    const json = `{"result":"x${C1_OSC}${BIDI}\u2028\x7f","big":123456789012345678901234567890}`;
    for (const stream of [{ isTTY: true }, device]) {
      const escaped = terminalSafeJson(json, stream);
      assert.doesNotMatch(escaped, /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
      assert.deepEqual(JSON.parse(escaped), JSON.parse(json));
      assert.match(escaped, /"big":123456789012345678901234567890}$/);
    }
    assert.equal(terminalSafeJson(json, file), json);
  }));

test('terminalSafeJson drops raw carriage returns, which valid JSON allows only between tokens', () =>
  withStreams(({ file, device }) => {
    const json = '{"result":"0xREAL","x":\r{"result":"0xFAKE"}  }';
    for (const stream of [{ isTTY: true }, device]) {
      const escaped = terminalSafeJson(json, stream);
      assert.equal(escaped, '{"result":"0xREAL","x":{"result":"0xFAKE"}  }');
      assert.deepEqual(JSON.parse(escaped), JSON.parse(json));
    }
    assert.equal(terminalSafeJson(json, file), json);
  }));

test('formatWarning sanitises the message for the stream it is printed on', () => withStreams(({ file, device }) => {
  assert.equal(formatWarning(`saved ${OSC52}${BIDI}`, { isTTY: true }), '⚠ saved safetxt.exe');
  assert.equal(formatWarning(`saved ${OSC52}${BIDI}`, device), '⚠ saved safetxt.exe');
  assert.equal(formatWarning(`saved ${OSC52}`, file), `⚠ saved ${OSC52}`);
}));

test('formatError sanitises the message unless stderr is a regular file', () => withStreams(({ file, device }) => {
  withStderrFd(device.fd, () => {
    assert.equal(formatError(`bad request ${OSC52}${C1_OSC}\nnext`), 'Error: bad request \nnext');
  });
  withStderrFd(file.fd, () => {
    assert.equal(formatError(new Error(`bad ${OSC52}`)), `Error: bad ${OSC52}`);
  });
}));
