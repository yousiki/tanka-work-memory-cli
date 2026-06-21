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

test('parses GJC JSONL messages and tool calls', () => {
  const entries = parseTranscript(
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'gjc-session-1',
        timestamp: '2026-06-18T00:00:00Z',
        cwd: '/work/proj',
        title: 'GJC test',
      }),
      JSON.stringify({
        type: 'model_change',
        model: 'openai-codex/gpt-5.5',
      }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello gjc' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        model: 'openai-codex/gpt-5.5',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking' },
            { type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: '/work/proj' }],
        },
      }),
    ].join('\n'),
  );

  assert.equal(entries.length, 6);
  assert.equal(categorize(entries[0]!.entry, 'gjc'), 'meta');
  assert.equal(categorize(entries[3]!.entry, 'gjc'), 'user');
  assert.equal(categorize(entries[4]!.entry, 'gjc'), 'tool');
  assert.equal(categorize(entries[5]!.entry, 'gjc'), 'tool-result');
  assert.equal(badgeLabel(entries[3]!.entry, 'gjc'), 'message · user');
  assert.equal(previewLine(entries[3]!.entry, 'gjc'), 'hello gjc');
  assert.match(previewLine(entries[4]!.entry, 'gjc'), /→ \[bash\]/);
  assert.match(previewLine(entries[5]!.entry, 'gjc'), /^← \/work\/proj/);

  const detail = entryDetail(entries[4]!.entry, 'gjc', entries[4]!.lineNo);
  assert.equal(detail.kind, 'message');
  if (detail.kind === 'message') {
    assert.equal(detail.role, 'assistant');
    assert.equal(detail.model, 'openai-codex/gpt-5.5');
    assert.equal(detail.blocks[0]!.kind, 'thinking');
    assert.equal(detail.blocks[1]!.kind, 'tool_use');
  }
});
