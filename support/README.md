# Upstream version support

`upstream-versions.json` records the Pi release this repo has **explicitly
accepted as supported** — meaning a human or agent has reviewed the upstream
release and confirmed this repo still works against it.

This package reads surfaces Pi does not promise to keep: the session JSONL
format, the extension event vocabulary the bridge subscribes to, and two CLI
flags. Pi releases several times a week and ships breaking changes in 0.x
minors, so the `notes` in the JSON say exactly what is coupled and which of it
fails closed on its own.

## How drift is detected

`.github/workflows/upstream-watch.yml` runs daily. It calls
`scripts/check-upstream.mjs`, which fetches npm's `latest` dist-tag for
`@earendil-works/pi-coding-agent` and compares it to `accepted`. If `latest` is
newer, the workflow opens (or updates) one rolling maintenance issue.

The automation **only detects drift**. It never reads changelogs, guesses what
broke, or edits this file. An open drift issue does not imply a known breakage
— it only means upstream moved.

## How to accept a new version

1. Read the upstream changelog linked in the drift issue.
2. Work through the issue's acceptance checklist: re-run the live probe
   (`npm run probe:live`) against the new release and diff the recordings; run
   the census over a session directory written by the new release.
3. If a recorded shape changed, regenerate the affected fixtures (see
   `testing/fixtures/README.md`) and write a new research note.
4. Bump `accepted` (and `checkedAt`) in a PR.
5. On the next run the bot sees no drift and closes the issue.

Bumping `accepted` is a deliberate human act. Do not bump it to silence the bot
without doing the review.
