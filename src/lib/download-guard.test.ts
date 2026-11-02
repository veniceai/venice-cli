import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isPublicAddress, resolveDownloadTarget, type ResolvedAddress } from './download-guard.js';
import { downloadToFile } from './media.js';

const downloadOptions = { maxBytes: 1024, expectedContentTypePrefixes: ['video/'] };

function recordingLookup(addresses: ResolvedAddress[]) {
  const hostnames: string[] = [];
  return {
    hostnames,
    lookup: async (hostname: string) => {
      hostnames.push(hostname);
      return addresses;
    },
  };
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ origin: string; port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits: () => hits,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function withTestApiOrigin<T>(origin: string, run: () => Promise<T>): Promise<T> {
  return withEnv({ NODE_ENV: 'test', VENICE_API_BASE_URL: `${origin}/api/v1` }, run);
}

test('isPublicAddress accepts global unicast addresses', () => {
  for (const address of [
    '8.8.8.8',
    '11.0.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.255.255',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('isPublicAddress rejects loopback, private, link-local, CGNAT, multicast and reserved addresses', () => {
  for (const address of [
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.192',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a00:1',
    'media.example',
    '',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('resolveDownloadTarget refuses non-https URLs and local names without a lookup', async () => {
  const { hostnames, lookup } = recordingLookup([{ address: '93.184.215.14', family: 4 }]);

  for (const url of [
    'http://media.example/clip.mp4',
    'ftp://media.example/clip.mp4',
    'file:///etc/passwd',
    'data:video/mp4;base64,AAAA',
    'https://localhost/clip.mp4',
    'https://LOCALHOST./clip.mp4',
    'https://media.localhost/clip.mp4',
  ]) {
    await assert.rejects(resolveDownloadTarget(new URL(url), lookup), /^Error: Refusing to download/, url);
  }
  assert.deepEqual(hostnames, []);
});

test('resolveDownloadTarget refuses non-public IP literals in any spelling', async () => {
  const { hostnames, lookup } = recordingLookup([]);

  for (const url of [
    'https://127.0.0.1/clip.mp4',
    'https://0x7f.1/clip.mp4',
    'https://2130706433/clip.mp4',
    'https://017700000001/clip.mp4',
    'https://127.1/clip.mp4',
    'https://[::1]/clip.mp4',
    'https://[::ffff:127.0.0.1]/clip.mp4',
    'https://[0:0:0:0:0:ffff:7f00:1]/clip.mp4',
    'https://169.254.169.254/latest/meta-data/',
    'https://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
    'https://10.0.0.1/clip.mp4',
    'https://192.168.0.10:8443/clip.mp4',
    'https://100.64.0.1/clip.mp4',
    'https://0/clip.mp4',
    'https://[::]/clip.mp4',
    'https://224.0.0.1/clip.mp4',
    'https://[fd00:ec2::254]/clip.mp4',
    'https://[fe80::1]/clip.mp4',
  ]) {
    await assert.rejects(resolveDownloadTarget(new URL(url), lookup), /is not a public address/, url);
  }
  assert.deepEqual(hostnames, []);
});

test('resolveDownloadTarget checks every address a hostname resolves to', async () => {
  for (const addresses of [
    [{ address: '10.1.2.3', family: 4 }],
    [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }, { address: 'fd12::1', family: 6 }],
    [{ address: '::ffff:192.168.1.1', family: 6 }],
  ]) {
    const { hostnames, lookup } = recordingLookup(addresses);
    await assert.rejects(
      resolveDownloadTarget(new URL('https://media.example/clip.mp4'), lookup),
      /resolves to .+, which is not a public address/,
      JSON.stringify(addresses)
    );
    assert.deepEqual(hostnames, ['media.example']);
  }

  await assert.rejects(
    resolveDownloadTarget(new URL('https://media.example/clip.mp4'), recordingLookup([]).lookup),
    /did not resolve/
  );
});

test('resolveDownloadTarget returns the checked addresses for public hosts', async () => {
  const addresses = [
    { address: '93.184.215.14', family: 4 },
    { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
  ];
  const noLookup = recordingLookup([]);

  assert.deepEqual(
    await resolveDownloadTarget(new URL('https://media.example/clip.mp4'), recordingLookup(addresses).lookup),
    addresses
  );
  assert.deepEqual(
    await resolveDownloadTarget(new URL('https://8.8.8.8/clip.mp4'), noLookup.lookup),
    [{ address: '8.8.8.8', family: 4 }]
  );
  assert.deepEqual(
    await resolveDownloadTarget(new URL('https://[2606:4700::1111]/clip.mp4'), noLookup.lookup),
    [{ address: '2606:4700::1111', family: 6 }]
  );
  assert.deepEqual(noLookup.hostnames, []);
});

test('downloadToFile follows at most five redirects on the test API origin', { timeout: 10_000 }, async () => {
  const api = await startServer((request, response) => {
    const remaining = Number(/^\/hop\/(\d+)$/.exec(request.url ?? '')?.[1]);
    if (remaining > 0) {
      response.writeHead(302, { Location: `/hop/${remaining - 1}` });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.end('video-bytes');
  });
  const dir = mkdtempSync(join(tmpdir(), 'venice-download-'));
  try {
    await withTestApiOrigin(api.origin, async () => {
      const five = join(dir, 'five.mp4');
      await downloadToFile(`${api.origin}/hop/5`, five, downloadOptions);
      assert.equal(readFileSync(five, 'utf8'), 'video-bytes');

      const six = join(dir, 'six.mp4');
      await assert.rejects(
        downloadToFile(`${api.origin}/hop/6`, six, downloadOptions),
        /Download failed: more than 5 redirects/
      );
      assert.equal(existsSync(six), false);
    });
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile refuses URLs and redirects that lead to other local servers', { timeout: 10_000 }, async () => {
  const intranet = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.end('internal-bytes');
  });
  const api = await startServer((request, response) => {
    const locations: Record<string, string> = {
      '/to-http': `${intranet.origin}/clip.mp4`,
      '/to-https': `https://127.0.0.1:${intranet.port}/clip.mp4`,
      '/to-ipv6': `https://[::1]:${intranet.port}/clip.mp4`,
    };
    const location = locations[request.url ?? ''];
    response.writeHead(location ? 307 : 404, location ? { Location: location } : {});
    response.end();
  });
  const dir = mkdtempSync(join(tmpdir(), 'venice-download-'));
  const output = join(dir, 'clip.mp4');
  try {
    await withTestApiOrigin(api.origin, async () => {
      for (const url of [
        `${intranet.origin}/clip.mp4`,
        `https://127.0.0.1:${intranet.port}/clip.mp4`,
        `${api.origin}/to-http`,
        `${api.origin}/to-https`,
        `${api.origin}/to-ipv6`,
      ]) {
        await assert.rejects(downloadToFile(url, output, downloadOptions), /^Error: Refusing to download/, url);
      }
    });
    assert.equal(intranet.hits(), 0);
    assert.equal(api.hits(), 3);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    await intranet.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile trusts the API stub origin only when NODE_ENV is test', { timeout: 10_000 }, async () => {
  const api = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.end('video-bytes');
  });
  const dir = mkdtempSync(join(tmpdir(), 'venice-download-'));
  try {
    await withEnv({ NODE_ENV: 'production', VENICE_API_BASE_URL: `${api.origin}/api/v1` }, async () => {
      await assert.rejects(
        downloadToFile(`${api.origin}/clip.mp4`, join(dir, 'clip.mp4'), downloadOptions),
        /Refusing to download from 127\.0\.0\.1:\d+: only https URLs are allowed/
      );
    });
    assert.equal(api.hits(), 0);
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile still reports a stalled download as a timeout', { timeout: 10_000 }, async () => {
  const api = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.write('partial');
  });
  const dir = mkdtempSync(join(tmpdir(), 'venice-download-'));
  try {
    await withTestApiOrigin(api.origin, async () => {
      await assert.rejects(
        downloadToFile(`${api.origin}/clip.mp4`, join(dir, 'clip.mp4'), { ...downloadOptions, timeoutMs: 100 }),
        /Download timed out after 1 seconds/
      );
    });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
