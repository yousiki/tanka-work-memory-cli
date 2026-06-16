import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  badgeLabel,
  categorize,
  entryDetail,
  parseTranscript,
  previewLine,
} from '../src/discovery/transcript';

const EXPORT_JSON = JSON.stringify({
  info: { id: 'sess-oc', title: 'OpenCode test' },
  messages: [
    {
      info: { id: 'msg-user', role: 'user', time_created: 1_700_000_000_000 },
      parts: [{ type: 'text', text: 'hello from opencode' }],
    },
    {
      info: { id: 'msg-assistant', role: 'assistant' },
      parts: [
        { type: 'reasoning', text: 'thinking' },
        {
          type: 'tool',
          name: 'bash',
          input: { command: 'pwd' },
          output: '/tmp/proj',
        },
      ],
    },
  ],
});

test('parses OpenCode export JSON into structured entries', () => {
  const entries = parseTranscript(EXPORT_JSON);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.entry.type, 'opencode_session');
  assert.equal(entries[1]!.entry.type, 'opencode_message');

  assert.equal(categorize(entries[0]!.entry, 'opencode'), 'meta');
  assert.equal(categorize(entries[1]!.entry, 'opencode'), 'user');
  assert.equal(categorize(entries[2]!.entry, 'opencode'), 'tool');
  assert.equal(badgeLabel(entries[1]!.entry, 'opencode'), 'message · user');
  assert.equal(
    previewLine(entries[1]!.entry, 'opencode'),
    'hello from opencode',
  );
  assert.match(previewLine(entries[2]!.entry, 'opencode'), /→ \[bash\]/);

  const detail = entryDetail(entries[2]!.entry, 'opencode', entries[2]!.lineNo);
  assert.equal(detail.kind, 'message');
  if (detail.kind === 'message') {
    assert.equal(detail.role, 'assistant');
    assert.equal(detail.blocks[0]!.kind, 'thinking');
    assert.equal(detail.blocks[1]!.kind, 'tool_use');
    assert.equal(detail.blocks[2]!.kind, 'tool_result');
  }
});

test('whole-file unknown JSON falls back to one raw/field entry', () => {
  const entries = parseTranscript('{"hello":"world"}');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.entry, { hello: 'world' });
});

test('parses Jcode session JSON into structured entries', () => {
  const entries = parseTranscript(
    JSON.stringify({
      id: 'session_jcode_1',
      created_at: '2026-06-16T00:00:00Z',
      provider_key: 'cliproxyapi',
      model: 'gpt-5.5-fast',
      working_dir: '/work/proj',
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: [{ type: 'text', text: 'hello jcode' }],
          timestamp: '2026-06-16T00:00:01Z',
        },
        {
          id: 'msg-assistant',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'tool_use', name: 'bash', input: { command: 'pwd' } },
          ],
        },
      ],
    }),
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.entry.type, 'jcode_session');
  assert.equal(entries[1]!.entry.type, 'jcode_message');
  assert.equal(categorize(entries[0]!.entry, 'jcode'), 'meta');
  assert.equal(categorize(entries[1]!.entry, 'jcode'), 'user');
  assert.equal(categorize(entries[2]!.entry, 'jcode'), 'tool');
  assert.equal(badgeLabel(entries[1]!.entry, 'jcode'), 'message · user');
  assert.equal(previewLine(entries[1]!.entry, 'jcode'), 'hello jcode');
  assert.match(previewLine(entries[2]!.entry, 'jcode'), /→ \[bash\]/);

  const detail = entryDetail(entries[2]!.entry, 'jcode', entries[2]!.lineNo);
  assert.equal(detail.kind, 'message');
  if (detail.kind === 'message') {
    assert.equal(detail.role, 'assistant');
    assert.equal(detail.blocks[0]!.kind, 'thinking');
    assert.equal(detail.blocks[1]!.kind, 'tool_use');
  }
});
