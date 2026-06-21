// biome-ignore-all lint/suspicious/noExplicitAny: session transcripts are heterogeneous JSON
// whose shape varies per agent and isn't consumed downstream — `any` plus local guards is the
// pragmatic choice here; precise typing would buy nothing.
/**
 * Framework-agnostic parsing & classification of coding-agent session transcripts (JSONL).
 *
 * Forked from the work-memory web renderer and stripped of all HTML — these functions return
 * plain data so this CLI's TUI (or any other renderer) can present it however it likes.
 */

export type TranscriptAgent =
  | 'claude-code'
  | 'codex'
  | 'cowork'
  | 'opencode'
  | 'jcode'
  | 'gjc'
  | 'unknown';

export type EntryCategory =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'tool-result'
  | 'hook'
  | 'system'
  | 'meta'
  | 'other';

/** One parsed JSONL line. `entry._unparsed` is set when the line wasn't valid JSON. */
export interface TranscriptEntry {
  /** 1-based source line number */
  lineNo: number;
  entry: any;
}

/** A renderable block inside a message entry's detail. */
export type DetailBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean; text: string; truncated: boolean }
  | { kind: 'image' }
  | { kind: 'json'; text: string };

/** Structured detail for one entry — what a viewer shows in its detail pane. */
export type EntryDetail =
  | { kind: 'unparsed'; lineNo: number; raw: string }
  | {
      kind: 'message';
      role: string;
      model?: string;
      timestamp?: string;
      category: EntryCategory;
      blocks: DetailBlock[];
      rawJson: string;
    }
  | { kind: 'fields'; rows: Array<[string, string]>; rawJson: string }
  | { kind: 'raw'; rawJson: string };

const SESSION_DETAIL_TEXT_MAX = 4000;

const CC_HOOK_TYPES = new Set([
  'hook_started',
  'hook_response',
  'hook_success',
  'hook_failure',
  'hook_additional_context',
  'hook_blocked',
  'hook',
]);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function openCodeEntries(parsed: any): TranscriptEntry[] | null {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages))
    return null;
  const looksOpenCode =
    parsed.info !== undefined ||
    parsed.messages.some(
      (m: any) =>
        m &&
        typeof m === 'object' &&
        (m.info !== undefined || m.parts !== undefined),
    );
  if (!looksOpenCode) return null;
  const out: TranscriptEntry[] = [];
  out.push({
    lineNo: 1,
    entry: { type: 'opencode_session', info: parsed.info ?? {} },
  });
  let lineNo = 2;
  for (const message of parsed.messages) {
    if (!message || typeof message !== 'object') continue;
    out.push({
      lineNo,
      entry: {
        type: 'opencode_message',
        info: message.info ?? {},
        parts: Array.isArray(message.parts) ? message.parts : [],
      },
    });
    lineNo += 1;
  }
  return out;
}

function jcodeEntries(parsed: any): TranscriptEntry[] | null {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages))
    return null;
  const looksJcode =
    typeof parsed.id === 'string' ||
    parsed.working_dir !== undefined ||
    parsed.provider_key !== undefined ||
    parsed.messages.some(
      (m: any) =>
        m &&
        typeof m === 'object' &&
        (m.role !== undefined || m.content !== undefined),
    );
  if (!looksJcode) return null;
  const out: TranscriptEntry[] = [];
  out.push({
    lineNo: 1,
    entry: {
      type: 'jcode_session',
      id: parsed.id,
      title: parsed.title,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      provider_key: parsed.provider_key,
      model: parsed.model,
      working_dir: parsed.working_dir,
      short_name: parsed.short_name,
      status: parsed.status,
      is_canary: parsed.is_canary,
      is_debug: parsed.is_debug,
      saved: parsed.saved,
    },
  });
  let lineNo = 2;
  for (const message of parsed.messages) {
    if (!message || typeof message !== 'object') continue;
    out.push({
      lineNo,
      entry: { type: 'jcode_message', ...message },
    });
    lineNo += 1;
  }
  return out;
}

/** Parse JSON/JSONL text → entries. Blank lines dropped; bad lines kept as `{ _unparsed }`. */
export function parseTranscript(text: string): TranscriptEntry[] {
  const source = String(text ?? '');
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const opencode = openCodeEntries(parsed);
      if (opencode) return opencode;
      const jcode = jcodeEntries(parsed);
      if (jcode) return jcode;
      return [{ lineNo: 1, entry: parsed }];
    } catch {
      // Fall back to JSONL line parsing; a JSONL transcript also starts with "{".
    }
  }
  const out: TranscriptEntry[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (ln.trim() === '') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(ln);
    } catch {
      parsed = { _unparsed: ln };
    }
    out.push({ lineNo: i + 1, entry: parsed });
  }
  return out;
}

/** Pull the textual content out of a CC/Codex message-shaped object. */
export function messageText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const bits: string[] = [];
  for (const block of content) {
    if (block == null) continue;
    if (typeof block === 'string') {
      bits.push(block);
      continue;
    }
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string') bits.push(block.text);
    else if (t === 'output_text' && typeof block.text === 'string')
      bits.push(block.text);
    else if (t === 'input_text' && typeof block.text === 'string')
      bits.push(block.text);
    else if (t === 'tool_use' || t === 'server_tool_use' || t === 'toolCall')
      bits.push(`→ [${block.name || 'tool'}]`);
    else if (t === 'tool_result' || t === 'toolResult') {
      const r = block.content;
      bits.push(typeof r === 'string' ? r : messageText(r));
    } else if (t === 'image') bits.push('[image]');
    else if (typeof block.text === 'string') bits.push(block.text);
  }
  return bits.join(' ').replace(/\s+/g, ' ').trim();
}

function firstToolUse(content: any): any {
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) return b;
    if (b && b.type === 'toolCall') return b;
  }
  return null;
}

function openCodeRole(entry: any): string {
  return String(
    entry.info?.role ?? entry.info?.type ?? entry.role ?? 'assistant',
  );
}

function openCodeParts(entry: any): any[] {
  return Array.isArray(entry.parts) ? entry.parts : [];
}

function openCodePartKind(part: any): string {
  return String(part?.type ?? part?.kind ?? part?.state?.status ?? 'part');
}

function openCodePartText(part: any): string {
  if (!part || typeof part !== 'object') return '';
  for (const key of ['text', 'content', 'output', 'title', 'summary']) {
    const value = part[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  if (part.input !== undefined) return prettyJson(part.input);
  if (part.data !== undefined) return prettyJson(part.data);
  return '';
}

/** Map an entry to one of the badge categories. Best-effort; unknown shapes → "other". */
export function categorize(entry: any, agent: string): EntryCategory {
  if (!entry || typeof entry !== 'object') return 'other';
  if (entry._unparsed !== undefined) return 'other';
  const type = entry.type;

  if (agent === 'claude-code' || agent === 'cowork') {
    if (type === 'user') {
      const c = entry.message?.content;
      if (
        Array.isArray(c) &&
        c.length &&
        c.every((b: any) => b && b.type === 'tool_result')
      ) {
        return 'tool-result';
      }
      return 'user';
    }
    if (type === 'assistant') {
      const c = entry.message?.content;
      return firstToolUse(c) ? 'tool' : 'assistant';
    }
    if (type === 'system') return 'system';
    if (
      type === 'summary' ||
      type === 'last-prompt' ||
      type === 'permission-mode' ||
      type === 'file-history-snapshot' ||
      type === 'command_permissions' ||
      type === 'skill_listing' ||
      type === 'deferred_tools_delta' ||
      type === 'task_reminder'
    ) {
      return 'meta';
    }
    const at = entry.attachment?.type;
    if (CC_HOOK_TYPES.has(type) || (at && CC_HOOK_TYPES.has(at))) return 'hook';
    return 'other';
  }

  if (agent === 'opencode') {
    if (type === 'opencode_session') return 'meta';
    if (type === 'opencode_message') {
      const role = openCodeRole(entry);
      if (role === 'user') return 'user';
      if (
        openCodeParts(entry).some((p) => openCodePartKind(p).includes('tool'))
      )
        return 'tool';
      return 'assistant';
    }
  }

  if (agent === 'jcode') {
    if (type === 'jcode_session') return 'meta';
    if (type === 'jcode_message') {
      const role = String(entry.display_role || entry.role || 'assistant');
      const content = entry.content;
      if (role === 'system') return 'system';
      if (role === 'user') {
        return Array.isArray(content) &&
          content.length > 0 &&
          content.every((b: any) => b?.type === 'tool_result')
          ? 'tool-result'
          : 'user';
      }
      return firstToolUse(content) ? 'tool' : 'assistant';
    }
  }

  if (agent === 'gjc') {
    if (
      type === 'session' ||
      type === 'model_change' ||
      type === 'thinking_level_change'
    ) {
      return 'meta';
    }
    if (type === 'message') {
      const role = String(entry.message?.role || '');
      if (role === 'system') return 'system';
      if (role === 'toolResult') return 'tool-result';
      if (role === 'user') return 'user';
      return firstToolUse(entry.message?.content) ? 'tool' : 'assistant';
    }
  }

  if (agent === 'codex') {
    if (
      type === 'session_meta' ||
      type === 'turn_context' ||
      type === 'compacted' ||
      type === 'turn_diff'
    ) {
      return 'meta';
    }
    if (type === 'event_msg') return 'system';
    if (type === 'response_item') {
      const p = entry.payload || {};
      const kind = p.type || p.role;
      if (kind === 'message')
        return p.role === 'user' || p.role === 'human' ? 'user' : 'assistant';
      if (
        kind === 'function_call' ||
        kind === 'local_shell_call' ||
        kind === 'custom_tool_call'
      )
        return 'tool';
      if (
        kind === 'function_call_output' ||
        kind === 'local_shell_call_output' ||
        kind === 'custom_tool_call_output'
      ) {
        return 'tool-result';
      }
      if (kind === 'reasoning') return 'assistant';
      return 'other';
    }
    return 'other';
  }

  if (type === 'user') return 'user';
  if (type === 'assistant') return 'assistant';
  if (type === 'system') return 'system';
  return 'other';
}

/** A short badge label for an entry (the type name, basically). */
export function badgeLabel(entry: any, agent: string): string {
  if (!entry || typeof entry !== 'object') return '(json)';
  if (entry._unparsed !== undefined) return '(unparsed)';
  if (agent === 'opencode') {
    if (entry.type === 'opencode_session') return 'session';
    if (entry.type === 'opencode_message')
      return `message · ${openCodeRole(entry)}`;
  }
  if (agent === 'jcode') {
    if (entry.type === 'jcode_session') return 'session';
    if (entry.type === 'jcode_message')
      return `message · ${entry.display_role || entry.role || 'assistant'}`;
  }
  if (agent === 'gjc') {
    if (entry.type === 'session') return 'session';
    if (entry.type === 'model_change') return 'model';
    if (entry.type === 'thinking_level_change') return 'thinking';
    if (entry.type === 'message')
      return `message · ${entry.message?.role || 'assistant'}`;
  }
  if (agent === 'codex' && entry.type === 'response_item') {
    const p = entry.payload || {};
    const k = p.type || p.role;
    return k ? `response · ${k}` : 'response_item';
  }
  if (agent === 'codex' && entry.type === 'event_msg') {
    const p = entry.payload || {};
    return p.type ? `event · ${p.type}` : 'event_msg';
  }
  if (agent === 'claude-code' || agent === 'cowork') {
    const at = entry.attachment?.type;
    if (at && CC_HOOK_TYPES.has(at)) return at;
    if (entry.type === 'system' && entry.subtype)
      return `system · ${entry.subtype}`;
  }
  return String(entry.type || '(json)');
}

/** A one-line preview string for the entry list. Plain text. */
export function previewLine(entry: any, agent: string): string {
  if (!entry || typeof entry !== 'object') return '(json)';
  if (entry._unparsed !== undefined)
    return truncate(String(entry._unparsed), 90);
  const type = entry.type;

  if (agent === 'claude-code' || agent === 'cowork') {
    if (type === 'permission-mode')
      return `permission mode: ${entry.permissionMode ?? '?'}`;
    if (type === 'summary') return truncate(String(entry.summary ?? ''), 90);
    if (type === 'last-prompt')
      return truncate(String(entry.lastPrompt ?? ''), 90);
    if (type === 'file-history-snapshot') return 'file history snapshot';
    if (type === 'command_permissions') return 'command permissions';
    if (type === 'skill_listing') return 'skill listing';
    if (type === 'deferred_tools_delta') return 'deferred tools delta';
    if (type === 'task_reminder') return 'task reminder';
    const at = entry.attachment?.type;
    if (CC_HOOK_TYPES.has(type) || (at && CC_HOOK_TYPES.has(at))) {
      const hn =
        entry.hookName ||
        entry.attachment?.hookName ||
        entry.hook_event_name ||
        entry.attachment?.hook_event_name;
      return `hook: ${hn || at || type}`;
    }
    if (type === 'user') {
      const c = entry.message?.content;
      const txt = messageText(c);
      if (
        !txt &&
        Array.isArray(c) &&
        c.some((b: any) => b && b.type === 'tool_result')
      ) {
        return '← [tool result]';
      }
      return truncate(txt || '(empty)', 88);
    }
    if (type === 'assistant') {
      const c = entry.message?.content;
      const tu = firstToolUse(c);
      const txt = messageText(c);
      if (tu)
        return `→ [${tu.name || 'tool'}]${txt ? ` ${truncate(txt, 60)}` : ' …'}`;
      return truncate(txt || '(empty)', 88);
    }
    if (type === 'system') {
      return truncate(
        messageText(entry.message?.content) ||
          entry.content ||
          entry.subtype ||
          'system',
        90,
      );
    }
  }

  if (agent === 'gjc') {
    if (type === 'session')
      return truncate(String(entry.title ?? entry.id ?? 'GJC session'), 90);
    if (type === 'model_change') return `model: ${entry.model ?? '?'}`;
    if (type === 'thinking_level_change')
      return `thinking: ${entry.thinkingLevel ?? '?'}`;
    if (type === 'message') {
      const role = String(entry.message?.role || 'assistant');
      const c = entry.message?.content;
      const txt = messageText(c);
      if (role === 'toolResult') return `← ${truncate(txt || '(empty)', 86)}`;
      const tu = firstToolUse(c);
      if (tu) {
        const toolText = Array.isArray(c)
          ? messageText(
              c.filter(
                (b: any) =>
                  b !== tu && b?.type !== 'thinking' && b?.type !== 'reasoning',
              ),
            )
          : txt;
        return `→ [${tu.name || 'tool'}]${toolText ? ` ${truncate(toolText, 60)}` : ' …'}`;
      }
      return truncate(txt || role || '(empty)', 88);
    }
  }

  if (agent === 'opencode') {
    if (type === 'opencode_session') {
      const info = entry.info || {};
      return truncate(String(info.title ?? info.id ?? 'OpenCode session'), 90);
    }
    if (type === 'opencode_message') {
      const parts = openCodeParts(entry);
      const tool = parts.find((p) => openCodePartKind(p).includes('tool'));
      const text = parts.map(openCodePartText).filter(Boolean).join(' ');
      if (tool)
        return `→ [${tool.name || tool.tool || 'tool'}]${text ? ` ${truncate(text, 60)}` : ' …'}`;
      return truncate(text || openCodeRole(entry), 88);
    }
  }

  if (agent === 'jcode') {
    if (type === 'jcode_session') {
      return truncate(String(entry.title ?? entry.id ?? 'Jcode session'), 90);
    }
    if (type === 'jcode_message') {
      const c = entry.content;
      const tu = firstToolUse(c);
      const txt = messageText(c);
      if (
        !txt &&
        Array.isArray(c) &&
        c.some((b: any) => b && b.type === 'tool_result')
      ) {
        return '← [tool result]';
      }
      if (tu)
        return `→ [${tu.name || 'tool'}]${txt ? ` ${truncate(txt, 60)}` : ' …'}`;
      return truncate(txt || entry.role || '(empty)', 88);
    }
  }

  if (agent === 'codex') {
    if (type === 'session_meta') return 'session meta';
    if (type === 'turn_context') return 'turn context';
    if (type === 'compacted') return 'compacted';
    if (type === 'turn_diff') return 'turn diff';
    if (type === 'event_msg') {
      const p = entry.payload || {};
      return `event: ${p.type || type}`;
    }
    if (type === 'response_item') {
      const p = entry.payload || {};
      const kind = p.type || p.role;
      if (kind === 'message')
        return truncate(messageText(p.content) || '(empty)', 88);
      if (kind === 'function_call' || kind === 'custom_tool_call') {
        return (
          `→ [${p.name || 'fn'}]` +
          (p.arguments ? ` ${truncate(String(p.arguments), 60)}` : ' …')
        );
      }
      if (kind === 'local_shell_call') return '→ [shell]';
      if (
        kind === 'function_call_output' ||
        kind === 'custom_tool_call_output' ||
        kind === 'local_shell_call_output'
      ) {
        const out = p.output;
        return (
          '← ' +
          truncate(
            typeof out === 'string' ? out : JSON.stringify(out ?? ''),
            86,
          )
        );
      }
      if (kind === 'reasoning') return '💭 reasoning';
      return kind ? String(kind) : 'response_item';
    }
  }

  if (type) {
    const txt = messageText(entry.message?.content);
    if (txt) return truncate(txt, 90);
  }
  return truncate(prettyJson(entry).replace(/\s+/g, ' '), 90);
}

function isMessageEntry(entry: any, agent: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (agent === 'claude-code' || agent === 'cowork') {
    return (
      (entry.type === 'user' || entry.type === 'assistant') &&
      entry.message &&
      typeof entry.message === 'object'
    );
  }
  if (agent === 'opencode') return entry.type === 'opencode_message';
  if (agent === 'jcode') return entry.type === 'jcode_message';
  if (agent === 'gjc')
    return (
      entry.type === 'message' &&
      entry.message &&
      typeof entry.message === 'object'
    );
  if (agent === 'codex') {
    return (
      entry.type === 'response_item' &&
      entry.payload &&
      (entry.payload.type === 'message' ||
        (entry.payload.role && entry.payload.content))
    );
  }
  return false;
}

/** Turn a message's `content` into renderable detail blocks. */
function openCodeBlocks(parts: any[]): DetailBlock[] {
  const out: DetailBlock[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const kind = openCodePartKind(part);
    const text = openCodePartText(part);
    if (kind === 'text' || kind === 'file' || kind === 'step-start') {
      if (text.trim()) out.push({ kind: 'text', text });
    } else if (kind === 'reasoning') {
      out.push({ kind: 'thinking', text: text || prettyJson(part) });
    } else if (kind.includes('tool')) {
      out.push({
        kind: 'tool_use',
        name: String(part.name || part.tool || part.toolName || 'tool'),
        input: part.input !== undefined ? prettyJson(part.input) : text,
      });
      const output = part.output ?? part.result ?? part.error;
      if (output !== undefined) {
        const raw = typeof output === 'string' ? output : prettyJson(output);
        const truncated = raw.length > SESSION_DETAIL_TEXT_MAX;
        out.push({
          kind: 'tool_result',
          isError: part.error !== undefined,
          text: truncated ? raw.slice(0, SESSION_DETAIL_TEXT_MAX) : raw,
          truncated,
        });
      }
    } else if (text.trim()) {
      out.push({ kind: 'text', text });
    } else {
      out.push({ kind: 'json', text: prettyJson(part) });
    }
  }
  return out;
}

function messageBlocks(content: any): DetailBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content))
    return [{ kind: 'json', text: prettyJson(content) }];
  const out: DetailBlock[] = [];
  for (const block of content) {
    if (block == null) continue;
    if (typeof block === 'string') {
      if (block.trim()) out.push({ kind: 'text', text: block });
      continue;
    }
    const t = block.type;
    if (
      (t === 'text' || t === 'output_text' || t === 'input_text') &&
      typeof block.text === 'string'
    ) {
      if (block.text.trim()) out.push({ kind: 'text', text: block.text });
    } else if (t === 'thinking' || t === 'reasoning') {
      const rt =
        block.thinking ||
        block.text ||
        (Array.isArray(block.summary)
          ? block.summary.map((s: any) => s?.text || '').join('\n')
          : '');
      out.push({ kind: 'thinking', text: String(rt || '') });
    } else if (
      t === 'tool_use' ||
      t === 'server_tool_use' ||
      t === 'toolCall'
    ) {
      out.push({
        kind: 'tool_use',
        name: String(block.name || 'tool'),
        input:
          block.input !== undefined
            ? prettyJson(block.input)
            : block.arguments !== undefined
              ? prettyJson(block.arguments)
              : '',
      });
    } else if (t === 'tool_result' || t === 'toolResult') {
      const raw =
        typeof block.content === 'string'
          ? block.content
          : messageText(block.content);
      const truncated = raw.length > SESSION_DETAIL_TEXT_MAX;
      out.push({
        kind: 'tool_result',
        isError: Boolean(block.is_error ?? block.isError),
        text: truncated
          ? raw.slice(0, SESSION_DETAIL_TEXT_MAX)
          : raw || '(empty)',
        truncated,
      });
    } else if (t === 'image') {
      out.push({ kind: 'image' });
    } else {
      out.push({ kind: 'json', text: prettyJson(block) });
    }
  }
  return out;
}

const NOTABLE_FIELDS = [
  'type',
  'subtype',
  'summary',
  'lastPrompt',
  'permissionMode',
  'hookName',
  'hook_event_name',
  'timestamp',
  'uuid',
  'parentUuid',
  'sessionId',
  'version',
  'title',
  'titleSource',
  'gitBranch',
  'cwd',
  'userType',
  'isSidechain',
  'requestId',
  'model',
  'id',
  'leafUuid',
  'parentId',
  'level',
  'toolUseID',
  'isMeta',
  'isCompactSummary',
  'isApiErrorMessage',
  'thinkingLevel',
  'provider',
  'api',
  'stopReason',
];

/** Build the structured detail for one entry. */
export function entryDetail(
  entry: any,
  agent: string,
  lineNo: number,
): EntryDetail {
  if (!entry || typeof entry !== 'object') {
    return { kind: 'raw', rawJson: String(entry) };
  }
  if (entry._unparsed !== undefined) {
    return { kind: 'unparsed', lineNo, raw: String(entry._unparsed) };
  }

  if (isMessageEntry(entry, agent)) {
    let role: string;
    let model: string | undefined;
    let content: any;
    if (agent === 'claude-code' || agent === 'cowork' || agent === 'gjc') {
      const m = entry.message || {};
      role = String(m.role || entry.type);
      model =
        typeof entry.model === 'string'
          ? entry.model
          : typeof m.model === 'string'
            ? m.model
            : undefined;
      content = m.content;
    } else if (agent === 'opencode') {
      const info = entry.info || {};
      role = openCodeRole(entry);
      model = typeof info.model === 'string' ? info.model : undefined;
      content = openCodeParts(entry);
    } else if (agent === 'jcode') {
      role = String(entry.display_role || entry.role || 'assistant');
      model = typeof entry.model === 'string' ? entry.model : undefined;
      content = entry.content;
    } else {
      const p = entry.payload || {};
      role = String(p.role || 'assistant');
      model = typeof p.model === 'string' ? p.model : undefined;
      content = p.content;
    }
    return {
      kind: 'message',
      role,
      model,
      timestamp:
        typeof entry.timestamp === 'string'
          ? entry.timestamp
          : typeof entry.info?.time_created === 'number'
            ? new Date(entry.info.time_created).toISOString()
            : undefined,
      category: categorize(entry, agent),
      blocks:
        agent === 'opencode' ? openCodeBlocks(content) : messageBlocks(content),
      rawJson: prettyJson(entry),
    };
  }

  // non-message known type: a list of notable scalar fields.
  const rows: Array<[string, string]> = [];
  const seen = new Set<string>();
  const pushRow = (k: string, v: unknown): void => {
    if (seen.has(k)) return;
    if (v === undefined || v === null || v === '') return;
    if (typeof v === 'object') return;
    seen.add(k);
    rows.push([k, String(v)]);
  };
  for (const k of NOTABLE_FIELDS) pushRow(k, entry[k]);
  if (
    entry.info &&
    typeof entry.info === 'object' &&
    !Array.isArray(entry.info)
  ) {
    for (const k of [
      'id',
      'role',
      'title',
      'model',
      'provider',
      'directory',
      'path',
      'time_created',
      'time_updated',
    ]) {
      pushRow(`info.${k}`, entry.info[k]);
    }
  }
  if (
    entry.payload &&
    typeof entry.payload === 'object' &&
    !Array.isArray(entry.payload)
  ) {
    for (const k of [
      'type',
      'id',
      'role',
      'name',
      'status',
      'call_id',
      'model',
      'summary',
    ]) {
      pushRow(`payload.${k}`, entry.payload[k]);
    }
  }
  if (
    entry.attachment &&
    typeof entry.attachment === 'object' &&
    !Array.isArray(entry.attachment)
  ) {
    for (const k of ['type', 'hookName', 'hook_event_name'])
      pushRow(`attachment.${k}`, entry.attachment[k]);
  }
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v !== 'object') pushRow(k, v);
  }

  if (rows.length === 0) return { kind: 'raw', rawJson: prettyJson(entry) };
  return { kind: 'fields', rows, rawJson: prettyJson(entry) };
}
