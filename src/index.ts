// Public surface of pi-terminal-headless. Populated stage by stage (see
// docs/plans/2026-09-22-initial-runtime.md). Only the root class, launch
// helpers, cold-read helpers and channel/condition types are exported;
// `reconcile/` and the channel readers are deliberately NOT, because the
// sequencer's single consumer must stay the root class.
export {}
