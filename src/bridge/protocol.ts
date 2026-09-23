// Wire protocol between the bridge extension (inside `pi`) and the host
// (`BridgeServer`, inside Agent Code's main process).
//
// Framing: one JSON object per line ("\n"-terminated, UTF-8) over a Unix
// socket the HOST listens on. The extension connects; it never listens
// (spec §6 rule 2 — a listen failure inside an extension kills `pi`).
//
// WHY the extension duplicates these constants instead of importing them:
// Agent Code ships `extension.ts` as a single file next to the app
// (out/main/runtime/pi/bridge.ts) and Pi loads it with jiti; a runtime
// import of this module would not resolve there. The extension imports
// TYPES only (erased), and `extension.test.ts` asserts the duplicated
// constants still equal these.

export const BRIDGE_PROTOCOL_VERSION = 1
export const BRIDGE_SOCKET_ENV = 'AGENT_CODE_PI_BRIDGE_SOCKET'
export const BRIDGE_TOKEN_ENV = 'AGENT_CODE_PI_BRIDGE_TOKEN'
/**
 * JSON `[{ name, url, headerEnv: { <header>: <env var holding its value> } }]`:
 * Agent Code's built-in MCP endpoints for this launch. Header values (the
 * bearer) travel in their own env vars, and the bridge deletes all of them
 * once read.
 */
export const MCP_SERVERS_ENV = 'AGENT_CODE_PI_MCP_SERVERS'
export type McpServerLaunchSpec = { name: string; url: string; headerEnv: Record<string, string> }

/** First frame on every connection. Anything else first ⇒ the host drops the peer. */
export type HelloFrame = {
  t: 'hello'
  token: string
  protocol: number
  pid: number
  /** Pi's own VERSION, when the extension could read it. */
  piVersion?: string
}

/**
 * Session identity carried by events that can change it. `file` may not exist
 * yet (a fresh session writes nothing until its first reply completes).
 */
export type SessionIdentity = { sessionId: string; file: string; leafId: string | null }

export type BridgeEvent =
  | { name: 'project_trust'; cwd: string }
  | ({ name: 'session_start'; reason: string; previousSessionFile?: string; idle: boolean } & SessionIdentity)
  | { name: 'session_shutdown'; reason: string; targetSessionFile?: string }
  | { name: 'session_tree'; newLeafId: string | null; oldLeafId: string | null; summaryEntryId?: string }
  | { name: 'session_compact'; compactionEntryId?: string; fromExtension?: boolean }
  | { name: 'session_compact_failed'; errorMessage?: string }
  | { name: 'compaction_start'; reason?: string }
  | { name: 'agent_start' }
  | { name: 'agent_end'; willRetry: boolean }
  | { name: 'agent_settled'; leafId: string | null }
  | { name: 'turn_start'; turnIndex: number }
  | { name: 'turn_end'; turnIndex: number; messageEntryId?: string; toolResultEntryIds: string[]; stopReason?: string; errorMessage?: string }
  /** Throttled stream hint from message_update / tool execution: what the agent is doing now. */
  | { name: 'phase'; phase: 'thinking' | 'responding' | 'tool' }
  | { name: 'tool_execution_start'; toolCallId: string; toolName: string }
  | { name: 'tool_execution_end'; toolCallId: string; toolName: string; isError: boolean }
  | { name: 'ui_prompt_start'; kind: string; title?: string }
  | { name: 'ui_prompt_end'; kind: string; title?: string }
  | { name: 'input'; source: string; streamingBehavior?: string }
  /** Once per process: what MCP discovery found per server (an error instead of tools when it failed). */
  | { name: 'mcp_status'; servers: Array<{ name: string; tools: number; error?: string }> }

export type EventFrame = { t: 'event'; at: number; event: BridgeEvent }

export type PromptOutcome =
  /** Pi started a run with our text as the user message. */
  | 'started'
  /** Pi queued our text behind the current run (followUp). */
  | 'queued'
  /** We asked; Pi gave no evidence either way before the deadline. The text may or may not arrive. */
  | 'unknown'

export type BridgeRequest =
  | { op: 'prompt'; text: string }
  | { op: 'abort' }
  | { op: 'state' }

export type BridgeState = {
  idle: boolean
  pending: boolean
  sessionId: string | null
  file: string | null
  leafId: string | null
}

export type RequestFrame = { t: 'request'; id: number } & BridgeRequest

export type ReplyFrame =
  | { t: 'reply'; id: number; ok: true; result: { outcome: PromptOutcome } | { aborted: true } | BridgeState }
  | { t: 'reply'; id: number; ok: false; error: string }

export type ExtensionFrame = HelloFrame | EventFrame | ReplyFrame
export type HostFrame = RequestFrame
