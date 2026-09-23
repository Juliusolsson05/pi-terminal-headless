// Host-facing test entry (reached as `pi-terminal-headless/testing/index`
// through Agent Code's alias; excluded from the published build). Lets the
// app's tests replay the same Stage 0 recordings through the real package
// instead of inventing Pi shapes of their own.

export { listLiveFixtures, loadLiveFixture, loadDurableFixtureText, toJsonl, fixturePath } from './fixtures.js'
export type { LiveFixture, RecordedEvent, RecordedRow } from './fixtures.js'
export { referenceActiveBranch, roles } from './oracle.js'
export { createReplaySandbox, FakePty, playReplay, waitUntil } from './replay.js'
export type { ReplayOptions, ReplaySandbox } from './replay.js'
export { bridgeEventsFromRecording } from './bridgeEvents.js'
