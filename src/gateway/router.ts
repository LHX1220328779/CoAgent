import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../errors.ts';
import { validateRequest, validateToolCall } from './protocol.ts';
import type { ModelAdapter, ModelEvent, ModelRequest, ToolCall, ModelUsage } from '../types.ts';
export class Semaphore {
  active = 0; limit: number; waiting: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (e: unknown) => void; abort: () => void }[] = [];
  constructor(limit: number) { if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency'); this.limit = limit; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.release(); }
    if (this.waiting.length >= 100) throw new AppError('Queue is full', 429, 'overloaded');
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => { this.waiting = this.waiting.filter(x => x !== entry); reject(signal.reason); } };
      this.waiting.push(entry); signal.addEventListener('abort', entry.abort, { once: true });
    });
  }
  private release() {
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = this.waiting.shift();
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(this.release()); }
      else this.active--;
    };
  }
}
export interface Route { adapter: ModelAdapter; model: string }
export interface RequestRecord { model: string; adapter: string; latencyMs: number; status: string; usage: ModelUsage | null }
export class ModelRouter {
  routes = new Map<string, Route[]>(); circuits = new Map<string, { failures: number; openUntil: number }>();
  semaphore: Semaphore; timeoutMs: number; retries: number; allowSimulatedTools: boolean; record: (r: RequestRecord) => void;
  constructor(options: { concurrency?: number; timeoutMs?: number; retries?: number; allowSimulatedTools?: boolean; record?: (r: RequestRecord) => void } = {}) {
    this.semaphore = new Semaphore(options.concurrency ?? 4); this.timeoutMs = options.timeoutMs ?? 120000;
    this.retries = options.retries ?? 2; this.allowSimulatedTools = options.allowSimulatedTools ?? false; this.record = options.record ?? (() => {});
  }
  register(alias: string, ...routes: Route[]) { if (!routes.length) throw new Error('Empty route'); this.routes.set(alias, routes); return this; }
  async *generate(request: ModelRequest, external: AbortSignal): AsyncGenerator<ModelEvent> {
    validateRequest(request);
    if (request.n !== undefined && request.n !== 1) throw new AppError('Only n=1 supported');
    const routes = this.routes.get(request.model);
    if (!routes) throw new AppError('Unknown model', 404, 'model_not_found');
    const signal = AbortSignal.any([external, AbortSignal.timeout(this.timeoutMs)]);
    const release = await this.semaphore.acquire(signal); const started = Date.now(); let adapterID = '', usage: ModelUsage | null = null, success = false;
    try {
      let last: unknown = new AppError('No available route', 503, 'unavailable');
      for (const route of routes) {
        adapterID = route.adapter.id;
        const cap = route.adapter.capabilities;
        if (request.tools?.length && !(cap.tools === 'native' || (cap.tools === 'simulated' && this.allowSimulatedTools))) { last = new AppError('Model lacks verified native tools', 422, 'capability_mismatch'); continue; }
        // UTF-8 bytes conservatively bound token count. Never silently trim conversation history.
        if (Buffer.byteLength(JSON.stringify({messages:request.messages,tools:request.tools})) + (request.max_tokens ?? cap.maxOutput) > cap.contextWindow) { last = new AppError('Context exceeds conservative byte budget', 413, 'context_length'); continue; }
        if (request.max_tokens && request.max_tokens > cap.maxOutput) { last = new AppError('Output token limit exceeded'); continue; }
        const key = `${adapterID}/${route.model}`;
        const circuit = this.circuits.get(key) ?? { failures: 0, openUntil: 0 };
        this.circuits.set(key, circuit);
        if (circuit.openUntil > Date.now()) { last = new AppError('Circuit open', 503, 'circuit_open'); continue; }
        for (let attempt = 0; attempt <= this.retries; attempt++) {
          let emitted = false; const calls = new Map<number, ToolCall>(); let finish: Extract<ModelEvent,{type:'finish'}> | undefined;
          try {
            for await (const event of route.adapter.generate({ ...request, model: route.model }, signal)) {
              signal.throwIfAborted();
              if (event.type === 'tool') {
                if (!Number.isInteger(event.index) || event.index < 0 || event.index > 63) throw new AppError('Invalid tool index', 502, 'protocol_error');
                const call = calls.get(event.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
                call.id += event.id ?? ''; call.function.name += event.name ?? ''; call.function.arguments += event.arguments ?? '';
                if (call.function.arguments.length > 1024 * 1024) throw new AppError('Tool arguments too large', 502, 'protocol_error');
                calls.set(event.index, call);
              } else if (event.type === 'finish') { finish = event; }
              else { if (event.type === 'usage') usage = event.usage; emitted = true; yield event; }
            }
            if (!finish || (calls.size > 0) !== (finish.reason === 'tool_calls')) throw new AppError('Inconsistent finish reason', 502, 'protocol_error');
            const ids = new Set<string>();
            for (const [index, call] of calls) {
              validateToolCall(call, request.tools ?? []);
              if (ids.has(call.id)) throw new AppError('Duplicate tool ID', 502, 'protocol_error'); ids.add(call.id);
            }
            for (const [index, call] of calls) { emitted = true; yield { type: 'tool', index, id: call.id, name: call.function.name, arguments: call.function.arguments }; }
            circuit.failures = 0; circuit.openUntil = 0; success = true; yield finish; return;
          } catch (error) {
            signal.throwIfAborted(); last = error;
            if (!(error instanceof AppError) || !error.retryable || emitted) throw error;
            if (++circuit.failures >= 3) circuit.openUntil = Date.now() + 30000;
            if (attempt < this.retries) await delay(Math.max(error.retryAfterMs, 100 * 2 ** attempt + Math.random() * 50), undefined, { signal });
          }
        }
      }
      throw last;
    } finally {
      release(); this.record({ model: request.model, adapter: adapterID, latencyMs: Date.now() - started, status: success ? 'succeeded' : signal.aborted ? 'canceled_or_timeout' : 'failed', usage });
    }
  }
}
