// Condition modules for Pi, built on the shared conditions core (vendored by
// Agent Code's scripts/sync-conditions-core.mjs into ./core).
//
// WHY attention-only (no actions): Pi has no permission system and no
// question tool (research/census-2026-09-22.md). What can block it is a
// dialog Pi renders itself — an extension's ui.confirm/select/input/editor
// (surfaced to extensions as ui_prompt_start/end) or Pi's project-trust
// selector at startup (project_trust, before session_start). Answering either
// from outside would mean driving Pi's own selector with keystrokes against a
// list we never see, so the conditions only raise the attention badge and the
// user answers in the TUI; they clear when Pi reports the dialog closed.
//
// WHY module order dialog, then trust: the evaluator's dedupe key is JSON over
// the conditions map in registry order, so the order is part of the contract.

import { defineModule, type ConditionAction } from './core/contract.js'
import type { PendingDialog } from '../live/types.js'

export type PiConditionInputs = {
  dialog: PendingDialog | null
  trustPending: boolean
}

export type PiDialogConditionState = { visible: true; kind: string; title: string }
export type PiTrustConditionState = { visible: true }

const NO_ACTIONS = (): ConditionAction[] => []

export const dialogModule = defineModule<'pi.dialog', PiConditionInputs, PiDialogConditionState>({
  kind: 'pi.dialog',
  detect: inputs => (inputs.dialog ? { visible: true, kind: inputs.dialog.kind, title: inputs.dialog.title } : null),
  actions: NO_ACTIONS,
})

export const trustModule = defineModule<'pi.trust', PiConditionInputs, PiTrustConditionState>({
  kind: 'pi.trust',
  detect: inputs => (inputs.trustPending ? { visible: true } : null),
  actions: NO_ACTIONS,
})

export const PI_TERMINAL_MODULES = [dialogModule, trustModule] as const
