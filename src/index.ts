// Public surface of pi-terminal-headless.
//
// Deliberately NOT exported: reconcile/ (its single consumer must stay the
// root class — spec "What is being isolated") and the channel readers'
// internals (DurableReader, BridgeServer, LiveStateProjector). Agent Code
// reaches Pi's files only through the cold-read helpers below, never by
// parsing the JSONL itself, so the schema stays in one place
// (transcript/SessionFile.ts).

export { PiTerminalHeadless } from './PiTerminalHeadless.js'
export type { PiActivity, PiTerminalError, PiTerminalHeadlessEvents, PiTerminalHeadlessOptions, SubmitPromptResult } from './PiTerminalHeadless.js'

export { preparePiTerminalLaunch } from './launch/prepareLaunch.js'
export type { PiTerminalLaunch, PreparePiLaunchOptions } from './launch/prepareLaunch.js'
export { encodeCwdForSessionDir, resolvePiAgentDir, resolvePiSessionDir, resolvePiSessionFile, sessionIdFromFileName } from './launch/sessionPaths.js'
export type { PiPathEnvironment } from './launch/sessionPaths.js'

export type { PtyDisposable, PtyExitEvent, PtyLike } from './terminal/PtyBinding.js'

export { listPiSessionFiles, PiHistoryError, readPiBranch, readPiHistory, summarizePiSession } from './transcript/history.js'
export type { PiHistoryPage, PiSessionSummary } from './transcript/history.js'
export { CURRENT_SESSION_VERSION, isMessageRow, messageRole, parseSessionText } from './transcript/SessionFile.js'
export type { PiMessage, PiMessageRow, PiSessionHeader, PiSessionRow } from './transcript/SessionFile.js'

export { dialogModule, PI_TERMINAL_MODULES, trustModule } from './conditions/modules.js'
export type { PiConditionInputs, PiDialogConditionState, PiTrustConditionState } from './conditions/modules.js'
export type { ConditionAction, ConditionCustomAction, ConditionRecord, ConditionSnapshot } from './conditions/core/contract.js'

export { CommittedChannel, ScreenChannel, SemanticChannel } from './channels/channels.js'
export type { CommittedEvent, ScreenEvent, SemanticEvent, SemanticSource } from './channels/types.js'
export type { PendingDialog, StreamPhase } from './live/types.js'
export type { PromptOutcome } from './bridge/protocol.js'
