import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyKeyBinding } from './e2ee.js';
import { isTdDebugMode, parseTdxQuote, type ParsedTdxQuote } from './tee.js';

const SIGNING_KEY =
  '044e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e47fd35c4215d1edf53e6f83de344615ce719bdb0fd878f6ed76f06dd277956de';
const SIGNING_ADDRESS = '2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const DEBUG_TD_ATTRIBUTES = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);

const TD_REPORT_FIELDS: Array<[keyof ParsedTdxQuote, number]> = [
  ['teeTcbSvn', 16],
  ['mrSeam', 48],
  ['mrSignerSeam', 48],
  ['seamAttributes', 8],
  ['tdAttributes', 8],
  ['xfam', 8],
  ['mrtd', 48],
  ['mrConfigId', 48],
  ['mrOwner', 48],
  ['mrOwnerConfig', 48],
  ['rtmr0', 48],
  ['rtmr1', 48],
  ['rtmr2', 48],
  ['rtmr3', 48],
  ['reportData', 64],
];

interface ReportOptions {
  length?: number;
  tdAttributes?: Buffer;
  reportData?: Buffer;
}

interface QuoteOptions {
  version?: number;
  teeType?: number;
  bodyType?: number;
  body?: Buffer;
  bodyLength?: number;
  signatureData?: Buffer;
}

function tdReport({ length = 584, tdAttributes = Buffer.alloc(8), reportData = Buffer.alloc(64) }: ReportOptions = {}): Buffer {
  const report = Buffer.alloc(length);
  tdAttributes.copy(report, 120);
  reportData.copy(report, 520);
  return report;
}

function patternedReport(length: number): Buffer {
  const report = Buffer.alloc(length, 0xee);
  let offset = 0;
  TD_REPORT_FIELDS.forEach(([, size], index) => {
    report.fill(index + 1, offset, offset + size);
    offset += size;
  });
  return report;
}

function buildQuote({
  version = 4,
  teeType = 0x81,
  bodyType = 2,
  body = tdReport(),
  bodyLength = body.length,
  signatureData = Buffer.alloc(0),
}: QuoteOptions = {}): Buffer {
  const header = Buffer.alloc(48);
  header.writeUInt16LE(version, 0);
  header.writeUInt16LE(2, 2);
  header.writeUInt32LE(teeType, 4);
  const signatureLength = Buffer.alloc(4);
  signatureLength.writeUInt32LE(signatureData.length);
  if (version !== 5) {
    return Buffer.concat([header, body, signatureLength, signatureData]);
  }
  const descriptor = Buffer.alloc(6);
  descriptor.writeUInt16LE(bodyType, 0);
  descriptor.writeUInt32LE(bodyLength, 2);
  return Buffer.concat([header, descriptor, body, signatureLength, signatureData]);
}

function withVersion(quote: Buffer, version: number): Buffer {
  const relabelled = Buffer.from(quote);
  relabelled.writeUInt16LE(version, 0);
  return relabelled;
}

test('parseTdxQuote reads every TD report field at the offset for the quote version', () => {
  const cases: Array<[string, number, Buffer]> = [
    ['v4', 4, buildQuote({ body: patternedReport(584) })],
    ['v5 TDX 1.0 report', 5, buildQuote({ version: 5, bodyType: 2, body: patternedReport(584) })],
    ['v5 TDX 1.5 report', 5, buildQuote({ version: 5, bodyType: 3, body: patternedReport(648) })],
  ];

  for (const [name, version, quote] of cases) {
    const parsed = parseTdxQuote(quote.toString('hex'));
    assert.ok(parsed, name);
    assert.equal(parsed.version, version, name);
    assert.equal(parsed.attestationKeyType, 2, name);
    assert.equal(parsed.teeType, 0x81, name);
    TD_REPORT_FIELDS.forEach(([field, size], index) => {
      assert.equal(parsed[field], (index + 1).toString(16).padStart(2, '0').repeat(size), `${name}: ${field}`);
    });
  }
});

test('a v5 quote with the TD debug bit set is reported as debug mode', () => {
  for (const [bodyType, length] of [[2, 584], [3, 648]]) {
    const body = tdReport({ length, tdAttributes: DEBUG_TD_ATTRIBUTES });
    const parsed = parseTdxQuote(buildQuote({ version: 5, bodyType, body }).toString('hex'));
    assert.ok(parsed, `body type ${bodyType}`);
    assert.equal(isTdDebugMode(parsed.tdAttributes), true, `body type ${bodyType}`);
  }

  const production = parseTdxQuote(buildQuote({ version: 5 }).toString('hex'));
  assert.ok(production);
  assert.equal(isTdDebugMode(production.tdAttributes), false);
});

test('the signing address in a v5 REPORTDATA binds the signing key', () => {
  const reportData = Buffer.concat([Buffer.from(SIGNING_ADDRESS, 'hex'), Buffer.alloc(44)]);
  for (const [bodyType, length] of [[2, 584], [3, 648]]) {
    const body = tdReport({ length, reportData });
    const parsed = parseTdxQuote(buildQuote({ version: 5, bodyType, body }).toString('hex'));
    assert.ok(parsed, `body type ${bodyType}`);
    assert.equal(verifyKeyBinding(SIGNING_KEY, parsed.reportData), true, `body type ${bodyType}`);
  }
});

test('parseTdxQuote accepts signature data of the declared length, upper-case hex and a 0x prefix', () => {
  const quote = buildQuote({ signatureData: Buffer.alloc(64, 0xab) }).toString('hex');

  assert.ok(parseTdxQuote(quote));
  assert.ok(parseTdxQuote(`0x${quote}`));
  assert.deepEqual(parseTdxQuote(quote.toUpperCase()), parseTdxQuote(quote));
});

test('parseTdxQuote rejects anything but exactly one well-formed TDX quote', () => {
  const v4 = buildQuote();
  const v5 = buildQuote({ version: 5 });
  const cases: Record<string, Buffer> = {
    empty: Buffer.alloc(0),
    'header only': v4.subarray(0, 48),
    'version 0': buildQuote({ version: 0 }),
    'version 3': buildQuote({ version: 3 }),
    'version 6': buildQuote({ version: 6 }),
    'SGX TEE type': buildQuote({ teeType: 0 }),
    'v5 SGX report body': buildQuote({ version: 5, bodyType: 1, body: Buffer.alloc(384) }),
    'v5 unknown body type': buildQuote({ version: 5, bodyType: 4 }),
    'v5 TDX 1.0 body type with the TDX 1.5 size': buildQuote({ version: 5, bodyType: 2, body: tdReport({ length: 648 }) }),
    'v5 TDX 1.5 body type with the TDX 1.0 size': buildQuote({ version: 5, bodyType: 3 }),
    'v5 descriptor size larger than the body': buildQuote({ version: 5, bodyLength: 648 }),
    'v5 truncated descriptor': v5.subarray(0, 52),
    'v4 layout labelled version 5': withVersion(v4, 5),
    'v5 layout labelled version 4': withVersion(v5, 4),
    'missing signature length': v4.subarray(0, 632),
    'truncated signature data': buildQuote({ signatureData: Buffer.alloc(64, 0xab) }).subarray(0, -1),
    'v4 trailing bytes': Buffer.concat([v4, Buffer.alloc(1)]),
    'v5 trailing bytes': Buffer.concat([v5, Buffer.alloc(1)]),
  };

  for (const [name, quote] of Object.entries(cases)) {
    assert.equal(parseTdxQuote(quote.toString('hex')), undefined, name);
  }
});

test('parseTdxQuote rejects a quote that is not strict hex', () => {
  const quote = buildQuote({ body: tdReport({ tdAttributes: DEBUG_TD_ATTRIBUTES }) }).toString('hex');
  const tdAttributesAt = (48 + 120) * 2;
  const cases: Record<string, string> = {
    'non-hex TD attributes': `${quote.slice(0, tdAttributesAt)}zz${quote.slice(tdAttributesAt + 2)}`,
    'odd length': `${quote}0`,
    whitespace: `${quote.slice(0, 100)} ${quote.slice(101)}`,
    'repeated prefix': `0x0x${quote}`,
  };

  for (const [name, hex] of Object.entries(cases)) {
    assert.equal(parseTdxQuote(hex), undefined, name);
  }
});

test('isTdDebugMode reads bit 0 of the attributes and treats malformed attributes as debug mode', () => {
  assert.equal(isTdDebugMode('0000000000000000'), false);
  assert.equal(isTdDebugMode('0100000000000000'), true);
  assert.equal(isTdDebugMode('0000000000000001'), false);

  for (const malformed of ['', '01', 'zz00000000000000', '000000000000000000', '0x00000000000000']) {
    assert.equal(isTdDebugMode(malformed), true, JSON.stringify(malformed));
  }
});
