import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cliPath = join(process.cwd(), 'dist', 'index.js');
const configModuleUrl = new URL('../lib/config.js', import.meta.url).href;
const historyModuleUrl = new URL('./history.js', import.meta.url).href;

function spawnNode(home: string, args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

function runNode(home: string, args: string[]): string {
  const result = spawnNode(home, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function assertNoAttachmentSecrets(value: string): void {
  assert.doesNotMatch(value, /https?:\/\/attachments\.example/i);
  assert.doesNotMatch(value, /U0VDUkVUX0FUVEFDSE1FTlQ=/);
}

test('history storage replaces attachment payloads and URLs with safe summaries', () => {
  const home = mkdtempSync(join(tmpdir(), 'venice-history-safe-'));
  try {
    const script = `
      import { addConversation } from ${JSON.stringify(configModuleUrl)};
      addConversation({
        id: 'new-attachment-history',
        timestamp: '2026-08-15T00:00:00.000Z',
        model: 'test-model',
        privacy: 'plain',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image_url', image_url: { url: 'https://attachments.example/photo.png' } },
            { type: 'input_audio', input_audio: { data: 'U0VDUkVUX0FUVEFDSE1FTlQ=', format: 'wav' } },
            { type: 'file', file: {
              file_data: 'data:application/pdf;base64,U0VDUkVUX0FUVEFDSE1FTlQ=',
              filename: 'report.pdf'
            } }
          ],
          name: 'unchanged-name'
        }]
      });
    `;
    runNode(home, ['--input-type=module', '--eval', script]);

    const history = readFileSync(join(home, '.venice', 'history.json'), 'utf8');
    assertNoAttachmentSecrets(history);
    const parsed = JSON.parse(history);
    assert.equal(parsed[0].messages[0].content, 'inspect [image] [audio] [file: report.pdf]');
    assert.equal(parsed[0].messages[0].name, 'unchanged-name');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('list, show JSON, and export sanitize legacy attachment history', () => {
  const home = mkdtempSync(join(tmpdir(), 'venice-history-legacy-'));
  const configDir = join(home, '.venice');
  const exportPath = join(home, 'export.json');
  mkdirSync(configDir, { recursive: true });
  const legacy = [{
    id: 'legacy-attachment-history',
    timestamp: '2026-08-15T00:00:00.000Z',
    model: 'test-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'legacy' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,U0VDUkVUX0FUVEFDSE1FTlQ=' },
        },
        {
          type: 'video_url',
          video_url: { url: 'https://attachments.example/video.mp4' },
        },
        {
          type: 'file',
          file: {
            file_data: 'https://attachments.example/private.pdf',
            filename: 'private.pdf',
          },
        },
      ],
      tool_call_id: 'unchanged-tool-id',
    }],
  }];
  writeFileSync(join(configDir, 'history.json'), JSON.stringify(legacy));

  try {
    const list = runNode(home, [cliPath, 'history', 'list', '--format', 'json']);
    const show = runNode(home, [
      cliPath, 'history', 'show', 'legacy-attachment-history', '--format', 'json',
    ]);
    runNode(home, [cliPath, 'history', 'export', exportPath]);
    const exported = readFileSync(exportPath, 'utf8');

    for (const output of [list, show, exported]) {
      assertNoAttachmentSecrets(output);
      assert.match(output, /legacy \[image\] \[video\] \[file: private\.pdf\]/);
    }
    assert.equal(JSON.parse(show).messages[0].tool_call_id, 'unchanged-tool-id');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('export creates nested directories', () => {
  const home = mkdtempSync(join(tmpdir(), 'venice-history-nested-'));
  const exportPath = join(home, 'nested', 'history.json');
  try {
    runNode(home, [cliPath, 'history', 'export', exportPath]);
    assert.deepEqual(JSON.parse(readFileSync(exportPath, 'utf8')), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('export reports write failures as formatted errors', () => {
  const home = mkdtempSync(join(tmpdir(), 'venice-history-error-'));
  const blockingFile = join(home, 'file.txt');
  writeFileSync(blockingFile, '');
  try {
    const script = `
      import { Command } from 'commander';
      import { registerHistoryCommand } from ${JSON.stringify(historyModuleUrl)};
      const program = new Command();
      registerHistoryCommand(program);
      await program.parseAsync(['node', 'venice', 'history', 'export', ${JSON.stringify(join(blockingFile, 'x.json'))}]);
    `;
    const result = spawnNode(home, ['--input-type=module', '--eval', script]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Error: /);
    assert.doesNotMatch(result.stderr, /^\s+at /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
