export { messageVersion } from './message-version.ts';
export type { ExecutionProgress, WorkDecision, WorkDecisionSource } from '../../protocol/src/index.ts';
import type { NativeResumeSpec } from '../../protocol/src/agent-sessions.ts';
export { assertPluginPermissions } from './permissions.ts';
export * from './background.ts';
import type { BackgroundContext, PluginEventSubscription } from './background.ts';
export * from './agent-artifacts.ts';
export type { Json, JsonObject } from '../../protocol/src/index.ts';
export type { InboxThing, InboxOrigin, NormalizedReplyEvidence, CollectedReplyEvidence } from '../../protocol/src/index.ts';
export { assertJson } from './json.ts';
import type { AppEvent, ExecutionResult, ExecutorInfo, Json, JsonObject, KnowledgeEntry, KnowledgeEditSource, KnowledgeImportance, KnowledgeLayer, PaneInfo, TerminalFrame, WebExtension } from '../../protocol/src/index.ts';
export type Dispose = () => void | Promise<void>;
/** SQLite and the event bus are intentionally small, synchronous local interfaces. */
export interface Store {
  /** Numeric document-id cursor; optional for in-memory third-party stores. */
  listAfter?<T>(collection: string, id: number, limit?: number): T[];
  get<T>(collection: string, id: string): T | undefined;
  list<T>(collection: string): T[];
  put<T>(collection: string, id: string, value: T): void;
  remove(collection: string, id: string): boolean;
  transaction<T>(fn: () => T): T;
  close(): void;
}
export interface EventBus {
  publish(type: string, data: Json): AppEvent;
  subscribe(listener: (event: AppEvent) => void): Dispose;
  since(id: number): AppEvent[];
}
export interface Tool {
  name: string;
  description: string;
  parameters: JsonObject;
  execute(args: JsonObject, signal: AbortSignal): Promise<Json>;
}
export interface Executor extends ExecutorInfo {
  /** False for task-only executors without a resident knowledge worker. */
  knowledgeWorker?: boolean;
  execute(request: { prompt: string; cwd?: string; executionMode?: 'task' | 'interactive'; nativeResume?: NativeResumeSpec; signal: AbortSignal; onOutput?: (text: string) => void }): Promise<{ text: string; pending?: boolean; sessionId?: string; nativeResult?: ExecutionResult }>;
}
export interface KnowledgeQuery { minRelevance?: number; importance?: KnowledgeImportance; tag?: string; layer?: KnowledgeLayer; projectId?: string; query?: string }
export interface KnowledgeBackend {
  revision?(id: string, commit?: string): Promise<{ entry: KnowledgeEntry; commit: string; previous?: string } | null>;
  list(query?: KnowledgeQuery): Promise<KnowledgeEntry[]>;
  put(entry: Omit<KnowledgeEntry, 'id' | 'updatedAt' | 'factsEdit' | 'importance' | 'relevance'> & { id?: string; relevance?: number | null; importance?: KnowledgeImportance | null }, expectedUpdatedAt?: string, editSource?: KnowledgeEditSource): Promise<KnowledgeEntry>;
  remove(id: string): Promise<boolean>;
}
export interface Routine { name: string; run(): Promise<Json> }
/** JSON-serializable channel metadata so core outbox, attention and approvals stay platform-agnostic. */
export interface ChannelContribution {
  [key: string]: Json | undefined;
  id: string;
  name: string;
  outboxPrefixes?: string[];
  approvalKinds?: string[];
  sourcePrefix?: string;
}
export interface InboxTriageContribution {
  [key: string]: Json | undefined;
  id: string;
  service: string;
}
export interface TerminalHostContribution {
  [key: string]: Json | undefined;
  id: string;
  name: string;
}
export interface ContributionMap { event_subscriptions: PluginEventSubscription; [point: `${string}.${string}`]: Json; skills: Json; context_providers: Json; model_providers: Json; channels: ChannelContribution; connectors: Json; inbox_triage: InboxTriageContribution; terminal_hosts: TerminalHostContribution; screen_parsers: Json; interaction_policies: Json; api: Json; events: Json; hooks: PluginHook; services: PluginService; service_wrappers: PluginServiceWrapper; tools: Tool; executors: Executor; knowledge_backends: KnowledgeBackend; routines: Routine; web_extensions: WebExtension }
export interface ExtensionPointDefinition { id: string; version: 1; transport?: 'json' | 'local' }
export interface Contributions {
  definePoint(definition: ExtensionPointDefinition): Dispose;
  points(): ExtensionPointDefinition[];
  add<K extends keyof ContributionMap>(kind: K, id: string, value: ContributionMap[K]): Dispose;
  list<K extends keyof ContributionMap>(kind: K): Array<{ id: string; value: ContributionMap[K] }>;
}
export type HookName = 'work.dispatch' | 'channel.send' | 'knowledge.put';
export type HookPhase = 'before' | 'after';
export type HookDecision = { action: 'continue'; value?: Json } | { action: 'deny'; reason: string };
export type PluginHookHandler = (value: Json, signal: AbortSignal) => HookDecision | void | Promise<HookDecision | void>;
export type ServiceHandler = (input: Json, signal: AbortSignal) => Promise<Json> | Json;
export type ServiceWrapper = (input: Json, next: (input: Json) => Promise<Json>, signal: AbortSignal) => Promise<Json>;
export interface InvocationOptions { order?: number; timeoutMs?: number }
export interface PluginHook extends InvocationOptions { name: HookName; phase: HookPhase; handler: PluginHookHandler }
export interface PluginService { name: string; version: 1; handler: ServiceHandler }
export interface PluginServiceWrapper extends InvocationOptions { name: string; handler: ServiceWrapper }
export const SDK_STABILITY = { apiVersion: 1, extensionContext: 'stable', contributions: 'stable', jsonServices: 'stable', storeTransactions: 'local-only', piRuntime: 'internal', agentArtifacts: 'experimental', background:'experimental' } as const;
export interface ExtensionContext extends Partial<BackgroundContext> {
  hook(name: HookName, phase: HookPhase, handler: PluginHookHandler, options?: InvocationOptions): Dispose;
  provide(name: string, handler: ServiceHandler): Dispose;
  use(name: string, input: Json): Promise<Json>;
  wrap(name: string, handler: ServiceWrapper, options?: InvocationOptions): Dispose;
  id: string;
  dataDir: string;
  config: JsonObject;
  store: Store;
  events: EventBus;
  contributions: Contributions;
  /** Host owns the disposer; plugins cannot leave listeners registered after disable. */
  contribute<K extends keyof ContributionMap>(kind: K, id: string, value: ContributionMap[K]): void;
  onEvent(listener: (event: AppEvent) => void): void;
  defer(dispose: Dispose): void;
}
export interface Extension {
  /** Stable feature IDs and internal workbench routes for optional sidebar links. */
  navigation?: import('../../protocol/src/index.ts').PluginNavigationItem[];
  id: string;
  name: string;
  capabilities: string[];
  dependencies?: string[];
  extensionPoints?: ExtensionPointDefinition[];
  permissions?: string[];
  activate(context: ExtensionContext): void | Promise<void>;
}
export interface NodeOptions { url: string; token: string; machineId: string; name: string; dataDir: string; agentInstanceId?: string; reconnectMs?: number; handlers?: Record<string, NodeHandler>; executors?: ExecutorInfo[]; onDisconnect?: () => void | Promise<void> }


/** Only explicitly registered methods may run on an execution node. */
export type NodeHandler = (params: JsonObject, emit: (event: string, data: Json) => void) => Promise<Json>;
export interface TerminalHost {
  describeInstance?(scope: { machineId: string; agentInstanceId?: string }): Promise<import('../../protocol/src/index.ts').TerminalHostInstance>;
  status(): Promise<{ available: boolean; reason?: string }>;
  list(): Promise<PaneInfo[]>;
  create(spec: { cwd: string; argv: string[]; name: string; keepOpen?: boolean; env?: Record<string, string> }): Promise<PaneInfo>;
  read(paneId: string): Promise<{ text: string; ansi: string }>;
  input(paneId: string, text: string): Promise<void>;
  keys(paneId: string, keys: string[]): Promise<void>;
  close(paneId: string): Promise<void>;
  watch(paneId: string, onFrame: (frame: TerminalFrame) => void, onError: (error: Error) => void): Promise<Dispose>;
}
export interface MachineClient {
  list(): import('../../protocol/src/index.ts').MachineInfo[];
  call(machineId: string, method: string, params: JsonObject, options?: { timeoutMs?: number }): Promise<Json>;
}
