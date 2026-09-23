// The three channels, in the siblings' shape: each publish emits the named
// event and then `'event'`, synchronously. They carry no logic of their own —
// ordering is decided upstream by the SessionSequencer.
//
// WHY a screen channel with no screen: like OpenCode Terminal, Pi Terminal has
// no headless xterm mirror (the bridge carries the state that matters). The
// channel exists so consumers that switch on channel kind see the same three
// channels for every provider; it carries activity and dialog facts.

import { EventEmitter } from 'node:events'

import type { CommittedEvent, ScreenEvent, SemanticEvent } from './types.js'

class Channel<E extends { type: string }> extends EventEmitter {
  publish(event: E): void {
    this.emit(event.type, event)
    this.emit('event', event)
  }
}

export class SemanticChannel extends Channel<SemanticEvent> {}
export class ScreenChannel extends Channel<ScreenEvent> {}
export class CommittedChannel extends Channel<CommittedEvent> {}
