/** Metadata is evidence of history, never proof that a CLI process is idle or running. */
/** Registered executor identity; bundled node adapters implement codex and claude-code. */
export type NativeExecutorId = string;
export interface NativeResumeSpec { executorId: NativeExecutorId; nativeSessionId: string }
export interface ObservedAgentSession extends NativeResumeSpec {
  id: string; cwd: string; observedAt: string; metadataTimestamp?: string; fileModifiedAt?: string;
  parentNativeSessionId?: string; source: 'session-metadata'; state: 'historical'; writable: false;
}
export interface AgentSessionDiscovery { sessions: ObservedAgentSession[]; roots: string[]; warnings: string[]; truncated: boolean }
