# pi-terminal-headless — initial runtime plan

Package-side half of Agent Code's
`docs/superpowers/plans/2026-09-22-pi-terminal-harness.md` (Tasks 2–5 and 12)
and its spec `docs/decomposition/pi-terminal.md` (Stages 0–5, bridge rules §6,
reconciliation rules §5.4). Those two documents are the source of truth; this
file only records package-local execution notes, so it does not duplicate the
design (the two would drift).

Tracking issue: Juliusolsson05/agent-code#1132.

## Order

1. Scaffold (this commit): contract scripts, CI/release/upstream-watch callers,
   support/, README.
2. Stage 0: sandboxed probe + recordings + oracle (`scripts/probe-live.mts`,
   `testing/fixtures/`, `research/`).
3. Stage 1: `src/transcript/` (durable reader, active branch).
4. Stage 2: `src/bridge/` + `src/live/` (bridge extension, socket server,
   projector).
5. Stage 3: `src/reconcile/`, root class, launch, conditions, channels.
6. Stage 5: opt-in live tier.
7. Stage 12: MCP tool proxy inside the bridge.

## Execution notes

- 2026-09-22 — repository created public (approved), scaffold copied from
  opencode-terminal-headless at 75536312.
- 2026-09-22 — Stage 0 recorded: 18 scenarios on Pi 0.87.1 (faux model, no
  login on this machine). H3/H5/H6 refined — doorbell is `turn_end`/
  `agent_settled` (never `message_end`), the bridge always sends
  `deliverAs: 'followUp'` (a busy prompt without it is silently lost), the live
  leaf comes from `session_tree`. See research/census-2026-09-22.md.
- 2026-09-22 — Stage 2: bridge extension + BridgeServer + LiveStateProjector.
  Reading Pi's source (agent-session-runtime.ts) showed /new, /resume, /fork
  and /reload re-run every extension factory, so the bridge keeps ONE
  process-wide link on a globalThis singleton and always calls the newest
  runtime's `pi` (a per-factory design would open a connection per switch and
  go inert after the first /new because the env is deleted on first load).
  Verified in the real pi 0.87.1 by the opt-in live tier, loading the bridge
  as a single copied file the way the app ships it.
- 2026-09-22 — Stage 3 + Stage 5: SessionSequencer, root class, launch,
  PtyBinding, conditions (attention-only pi.dialog / pi.trust), channels, the
  replay rig and the live tier. Every recording replays end to end through the
  real root class with real sockets and files; the live tier passes against
  real pi 0.87.1 (fresh session + tool turn, resume without re-emitting
  history). Bug found by the tests: stop() during start() hung because a
  close racing listen() never settled the listen promise — fixed in
  BridgeServer.listen.
