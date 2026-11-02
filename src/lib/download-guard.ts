/**
 * Restrictions on downloading media from URLs named in API responses
 */

import { promises as dns } from 'dns';
import * as http from 'http';
import * as https from 'https';
import { isIP, type LookupFunction } from 'net';
import { Readable } from 'stream';

export type ResolvedAddress = { address: string; family: number };
export type AddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const MAX_DOWNLOAD_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const NON_PUBLIC_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
];

const systemLookup: AddressLookup = (hostname) => dns.lookup(hostname, { all: true });

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function isPublicIPv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return NON_PUBLIC_IPV4_RANGES.every(([base, prefixLength]) => {
    const start = ipv4ToNumber(base);
    return value < start || value >= start + 2 ** (32 - prefixLength);
  });
}

function hextetsOf(part: string): number[] {
  if (!part) return [];
  return part.split(':').flatMap((piece) => {
    if (!piece.includes('.')) return [Number.parseInt(piece, 16)];
    const value = ipv4ToNumber(piece);
    return [Math.floor(value / 0x10000), value % 0x10000];
  });
}

function ipv6ToHextets(address: string): number[] {
  const [head, tail] = address.split('%')[0].split('::');
  if (tail === undefined) return hextetsOf(head);

  const start = hextetsOf(head);
  const end = hextetsOf(tail);
  return [...start, ...new Array<number>(8 - start.length - end.length).fill(0), ...end];
}

function isPublicIPv6(address: string): boolean {
  const hextets = ipv6ToHextets(address);
  const [first, second] = hextets;
  const embeddedIPv4 = [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join('.');

  const ipv4Mapped = hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
  const nat64 = first === 0x64 && second === 0xff9b && hextets.slice(2, 6).every((hextet) => hextet === 0);
  if (ipv4Mapped || nat64) return isPublicIPv4(embeddedIPv4);

  if ((first & 0xe000) !== 0x2000) return false; // outside global unicast 2000::/3
  if (first === 0x2001 && second < 0x0200) return false; // 2001::/23, including Teredo
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false; // 6to4
  if (first === 0x3fff && second < 0x1000) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

function refused(url: URL, reason: string): Error {
  return new Error(`Refusing to download from ${url.host || url.protocol}: ${reason}.`);
}

export async function resolveDownloadTarget(
  url: URL,
  lookup: AddressLookup = systemLookup
): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'https:') {
    throw refused(url, 'only https URLs are allowed');
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw refused(url, 'it names this machine');
  }

  const family = isIP(hostname);
  if (family !== 0) {
    if (!isPublicAddress(hostname)) {
      throw refused(url, `${hostname} is not a public address`);
    }
    return [{ address: hostname, family }];
  }

  const addresses = await lookup(hostname);
  if (addresses.length === 0) {
    throw refused(url, 'the host did not resolve');
  }
  const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
  if (blocked) {
    throw refused(url, `it resolves to ${blocked.address}, which is not a public address`);
  }
  return addresses;
}

// The test API stub is exempt, matching the API base URL override that is
// honoured only when NODE_ENV=test.
function trustedTestOrigin(): string | undefined {
  const apiBaseUrl = process.env.NODE_ENV === 'test' ? process.env.VENICE_API_BASE_URL : undefined;
  if (!apiBaseUrl) return undefined;
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return undefined;
  }
}

function parseDownloadUrl(value: string, base?: URL): URL {
  try {
    return new URL(value, base);
  } catch {
    throw new Error('Download failed: the download URL is not valid.');
  }
}

// Connect to the addresses that were checked rather than resolving the host
// again, so a second DNS answer cannot point the request somewhere else.
function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
}

function get(
  url: URL,
  addresses: ResolvedAddress[] | undefined,
  signal: AbortSignal
): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, {
      agent: false,
      signal,
      ...(addresses ? { lookup: pinnedLookup(addresses) } : {}),
    }, resolve);
    request.on('error', reject);
  });
}

function toResponse(message: http.IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, item);
    }
  }

  const status = message.statusCode ?? 200;
  const body = status === 204 || status === 205
    ? null
    : Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, statusText: message.statusMessage, headers });
}

export async function fetchDownload(url: string, signal: AbortSignal): Promise<Response> {
  let target = parseDownloadUrl(url);

  for (let redirects = 0; ; redirects++) {
    const addresses = target.origin === trustedTestOrigin()
      ? undefined
      : await resolveDownloadTarget(target);
    const message = await get(target, addresses, signal);
    const status = message.statusCode ?? 0;
    const location = message.headers.location;

    if (REDIRECT_STATUSES.has(status) && location) {
      message.destroy();
      if (redirects === MAX_DOWNLOAD_REDIRECTS) {
        throw new Error(`Download failed: more than ${MAX_DOWNLOAD_REDIRECTS} redirects.`);
      }
      target = parseDownloadUrl(location, target);
      continue;
    }

    if (status < 200 || status > 299) {
      message.destroy();
      throw new Error(`Download failed: ${status} ${message.statusMessage ?? ''}`.trim());
    }
    return toResponse(message);
  }
}
