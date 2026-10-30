export type AgentRole = 'lead' | 'sidekick' | 'reviewer' | 'explorer';
export type TaskStatus = 'queued' | 'running' | 'reviewing' | 'awaiting_approval' | 'succeeded' | 'failed' | 'canceled' | 'paused' | 'blocked';
export interface ModelCapabilities {
  streaming: boolean; tools: 'native' | 'simulated' | 'none'; parallelTools: boolean;
  contextWindow: number; maxOutput: number; protocols: ('chat' | 'responses' | 'messages')[];
}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDefinition { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface Message { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content?: string | null | unknown[]; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ModelRequest { model: string; messages: Message[]; tools?: ToolDefinition[]; stream?: boolean; max_tokens?: number; [key: string]: unknown }
export interface ModelUsage { inputTokens: number; outputTokens: number; cachedTokens: number; cost: number | null; estimated: boolean }
export type ModelEvent = { type: 'text'; text: string } | { type: 'tool'; index: number; id?: string; name?: string; arguments?: string } | { type: 'usage'; usage: ModelUsage } | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' };
export interface ModelAdapter { id: string; capabilities: ModelCapabilities; generate(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> }
export interface ModelRef { providerID: string; modelID: string }
export interface AgentSession { id: string; runtimeID: string; role: AgentRole; directory: string; model: ModelRef; summary: string; state: 'idle' | 'running'; taskID?:string }
export interface TaskDependency { taskID: string; dependsOn: string }
export interface Task {
  id: string; title: string; prompt: string; repo: string; dependsOn: string[]; priority: number;
  workspaceMode?: 'direct' | 'worktree';
  status: TaskStatus; role: AgentRole; model: ModelRef; reviewerModel: ModelRef;
  attempts: number; maxAttempts: number; timeoutMs: number; worktree: string | null;
  result: string | null; error: string | null; acceptance: string[] | null;
  requiresApproval: boolean; approved: boolean; createdAt: number; updatedAt: number;
  reviewPending?: boolean;
}
export interface TaskExecution { id: string; taskID: string; attempt: number; startedAt: number; finishedAt: number | null; status: TaskStatus; error: string | null }
export interface RuntimeResult { text: string; usage: ModelUsage; parts: unknown[] }
export interface AgentRuntime {
  toolHistory?(id: string, directory: string): Promise<unknown[]>;
  create(role: AgentRole, directory: string, model: ModelRef, parentID?: string): Promise<string>;
  prompt(id: string, role: AgentRole, directory: string, model: ModelRef, prompt: string, signal: AbortSignal): Promise<RuntimeResult>;
  abort(id: string, directory: string): Promise<void>;
}
export interface WorktreeManager { create(taskID: string, repo: string): Promise<string>; diff(directory: string): Promise<string>; remove(directory: string, repo: string): Promise<void> }
export interface AgentOrchestrator { tick(): Promise<void>; pause(id: string): Promise<void>; cancel(id: string): Promise<void>; resume(id: string): void }
