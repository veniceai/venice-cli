/**
 * Builds Intel TDX quotes for tests. Every part defaults to a well-formed
 * version 4 quote whose signature data has the real layout: ECDSA signature,
 * attestation key, then certification data type, size and bytes.
 */

const HEADER_BYTES = 48;
const BODY_BYTES: Record<number, number> = { 2: 584, 3: 648 };
const TD_ATTRIBUTES_OFFSET = 120;
const REPORT_DATA_OFFSET = 520;
const QE_REPORT_CERTIFICATION_DATA = 6;

export interface TdxQuoteOptions {
  version?: number;
  teeType?: number;
  /** Version 5 body descriptor type: 2 is a TDX 1.0 TD report, 3 is TDX 1.5. */
  bodyType?: number;
  body?: Buffer;
  /** Version 5 body descriptor size. Defaults to the body's length. */
  bodyLength?: number;
  tdAttributes?: Buffer;
  /** Hex copied to the start of REPORTDATA, such as a signing address. */
  reportData?: string;
  certificationData?: Buffer;
  /** Overrides the signature data length written before the signature data. */
  signatureLength?: number;
  /** Overrides the certification data size inside the signature data. */
  certificationDataSize?: number;
  trailing?: Buffer;
}

export function buildTdxQuoteBytes(options: TdxQuoteOptions = {}): Buffer {
  const { version = 4, teeType = 0x81, bodyType = 2, certificationData = Buffer.alloc(0) } = options;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(version, 0);
  header.writeUInt16LE(2, 2);
  header.writeUInt32LE(teeType, 4);

  const body = Buffer.from(options.body ?? Buffer.alloc(BODY_BYTES[bodyType] ?? BODY_BYTES[2]));
  options.tdAttributes?.copy(body, TD_ATTRIBUTES_OFFSET);
  if (options.reportData) Buffer.from(options.reportData, 'hex').copy(body, REPORT_DATA_OFFSET);

  const descriptor = Buffer.alloc(6);
  descriptor.writeUInt16LE(bodyType, 0);
  descriptor.writeUInt32LE(options.bodyLength ?? body.length, 2);

  const certificationHeader = Buffer.alloc(6);
  certificationHeader.writeUInt16LE(QE_REPORT_CERTIFICATION_DATA, 0);
  certificationHeader.writeUInt32LE(options.certificationDataSize ?? certificationData.length, 2);
  const signatureData = Buffer.concat([
    Buffer.alloc(64, 0xab),
    Buffer.alloc(64, 0xcd),
    certificationHeader,
    certificationData,
  ]);
  const signatureLength = Buffer.alloc(4);
  signatureLength.writeUInt32LE(options.signatureLength ?? signatureData.length);

  return Buffer.concat([
    header,
    version === 5 ? descriptor : Buffer.alloc(0),
    body,
    signatureLength,
    signatureData,
    options.trailing ?? Buffer.alloc(0),
  ]);
}

export function buildTdxQuote(options: TdxQuoteOptions = {}): string {
  return buildTdxQuoteBytes(options).toString('hex');
}
