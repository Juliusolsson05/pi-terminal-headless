# pi-terminal-headless

Agent Code's headless adapter for the native [Pi](https://pi.dev) coding-agent
TUI. The caller runs `pi` in a PTY it owns; this package reads what Pi does and
reports it in the provider event shape Agent Code consumes: activity, turns,
committed transcript, history, blocking dialogs, session switches, and prompt
delivery.

## Should you use this package?

Probably not. It exists so Agent Code can treat a Pi TUI pane as a real agent.
It couples to Pi's session file format and extension events, which change
across Pi's 0.x releases (see `support/upstream-versions.json`). If you want to
drive Pi programmatically without its TUI, use Pi's own RPC mode
(`pi --mode rpc`) or its SDK instead.

## How it reads Pi

| Signal | Channel | Source |
|---|---|---|
| Committed entries, history | durable | the session JSONL, projected onto the active branch of Pi's entry tree |
| Activity, turns, stream phase | live | the bridge extension: `agent_start` / `agent_settled`, `turn_start` / `turn_end`, `message_update` |
| Session identity and switches (`/new`, `/resume`, `/fork`, `/tree`) | live | `session_start`, `session_tree` |
| Blocking dialogs | live | `ui_prompt_start` / `ui_prompt_end` |
| Prompt delivery, abort | live | `pi.sendUserMessage`, `ctx.abort()` |
| Screen | none | no headless terminal mirror |

The **bridge** is a small Pi extension (`src/bridge/extension.ts`) that the
caller passes to `pi -e`. It connects back to a Unix socket the host listens
on, authenticates with a per-spawn token, and only observes: it never blocks
tools, answers dialogs or changes settings. Every error inside it is contained,
because an unhandled error in an extension kills the user's `pi`.

## Requirements

- Pi at or near the accepted version in `support/upstream-versions.json`.
- A PTY owned by the caller (`node-pty` is an optional peer dependency).
  **This package never spawns or kills a process.**

## Development

```bash
npm install
npm run check                      # contract, typecheck, tests, pack verification
PI_TERMINAL_HEADLESS_LIVE=1 PI_BINARY=<path to pi> NODE_PTY_PATH=<node-pty dir> npm run test:live
```

Tests are built from recordings of the real Pi TUI, made in a sandbox
(isolated agent dir, Pi's scripted `faux` provider). See
`testing/fixtures/README.md`.

The real-model tier runs the same contract against a logged-in Pi and a real
model (thinking blocks, real tool calls, a generated compaction summary). It
copies `~/.pi/agent`'s auth and settings into a temp sandbox, costs a few model
calls, and never runs in CI:

```bash
PI_TERMINAL_HEADLESS_REAL_MODEL=1 PI_BINARY=<path to pi> NODE_PTY_PATH=<node-pty dir> \
  [PI_REAL_MODEL_OUT=<dir to keep the session files>] npm run test:live -- src/PiTerminalHeadless.realModel.live.test.ts
```

## License

MIT
