import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { AppError } from '../errors.ts';
import type { ModelRequest, ToolCall, ToolDefinition } from '../types.ts';
const ajv = new Ajv({ strict: false, allErrors: true });
const ajv2020 = new Ajv2020({strict:false,allErrors:true});
const ajv2019 = new Ajv2019({strict:false,allErrors:true});
function compile(schema:Record<string,unknown>){const dialect=String(schema?.$schema ?? '');const engine=dialect.includes('2020-12')?ajv2020:dialect.includes('2019-09')?ajv2019:ajv;const validator=engine.compile(schema);engine.removeSchema(schema);return validator;}
export function validateRequest(value: unknown): asserts value is ModelRequest {
  if (!value || typeof value !== 'object') throw new AppError('Expected JSON object');
  const r = value as ModelRequest;
  if (typeof r.model !== 'string' || !r.model || !Array.isArray(r.messages) || !r.messages.length) throw new AppError('model and messages required');
  if (r.stream !== undefined && typeof r.stream !== 'boolean') throw new AppError('stream must be boolean');
  if (r.max_tokens !== undefined && (!Number.isInteger(r.max_tokens) || r.max_tokens <= 0)) throw new AppError('max_tokens must be positive');
  const pending = new Set<string>(), seen = new Set<string>();
  for (const [index,m] of r.messages.entries()) {
    if (!m || !['system','developer','user','assistant','tool'].includes(m.role)) throw new AppError('Invalid message role');
    if (m.content === undefined && !(m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) throw new AppError(`Missing message content at index ${index}`);
    if (m.content !== undefined && m.content !== null && typeof m.content !== 'string' && !Array.isArray(m.content)) throw new AppError(`Invalid message content at index ${index} (${typeof m.content})`);
    if (pending.size && m.role !== 'tool') throw new AppError('Missing tool results');
    if (m.role === 'tool' && (!m.tool_call_id || !pending.delete(m.tool_call_id))) throw new AppError('Orphan or duplicate tool result');
    if (m.tool_calls) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) throw new AppError('Invalid tool_calls');
      for (const call of m.tool_calls) {
        validateCallShape(call);
        if (seen.has(call.id)) throw new AppError('Duplicate tool call ID');
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new AppError('Missing tool results');
  if (r.tools !== undefined) {
    if (!Array.isArray(r.tools)) throw new AppError('tools must be an array');
    const names = new Set<string>();
    for (const tool of r.tools) {
      if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name || names.has(tool.function.name)) throw new AppError('Invalid or duplicate tool');
      names.add(tool.function.name);
      try { compile(tool.function.parameters); } catch { throw new AppError('Invalid tool JSON schema'); }
    }
  }
}
export function validateCallShape(call: ToolCall) {
  if (!call || typeof call.id !== 'string' || !call.id || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw new AppError('Malformed tool call', 502, 'protocol_error');
}
export function validateToolCall(call: ToolCall, tools: ToolDefinition[]) {
  validateCallShape(call);
  const tool = tools.find(t => t.function.name === call.function.name);
  if (!tool) throw new AppError('Unknown tool requested', 502, 'protocol_error');
  let args: unknown;
  try { args = JSON.parse(call.function.arguments); } catch { throw new AppError('Tool arguments are not JSON', 502, 'protocol_error'); }
  const validate = compile(tool.function.parameters);
  if (!validate(args)) throw new AppError('Tool arguments violate schema', 502, 'protocol_error');
  return args;
}
/** Handles fragmented UTF-8, CRLF, multiline data and explicit stream termination. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted(); const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024) throw new AppError('SSE event too large', 502, 'protocol_error');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data: string[] = []; let event = 'message';
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          if (line.startsWith('event:')) event = line.slice(6).trim();
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
      if (done) { signal?.throwIfAborted(); if (buffer.trim()) throw new AppError('Truncated SSE event', 502, 'stream_interrupted'); break; }
    }
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
