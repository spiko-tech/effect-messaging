/** @internal */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import type * as Scope from "effect/Scope"

export interface Options {
  readonly maxOut?: number
  readonly cancelAfter?: number
}
export interface State {
  readonly interval: number
  readonly maxOut: number
  readonly cancelAfter: number
  readonly missed: number
  readonly count: number
  readonly active: boolean
  readonly generation: number
}
export interface Heartbeat {
  readonly work: Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
  readonly restart: Effect.Effect<void>
  readonly change: (interval: number, cancelAfter?: number, maxOut?: number) => Effect.Effect<void>
  readonly state: Effect.Effect<State>
}

/** A scoped idle lease. Control changes wake the deadline driver immediately; work preserves the tick cadence. */
export const make = Effect.fnUntraced(function*<R>(
  interval: number,
  onMissed: (missed: number) => Effect.Effect<boolean, never, R>,
  options: Options = {}
): Effect.fn.Return<Heartbeat, never, Scope.Scope | R> {
  const changed = Latch.makeUnsafe()
  const started = yield* Clock.currentTimeMillis
  let last = started
  let next = started + interval
  let expires = options.cancelAfter ? started + options.cancelAfter : Infinity
  let state: State = {
    interval,
    maxOut: options.maxOut || 2,
    cancelAfter: options.cancelAfter || 0,
    missed: 0,
    count: 0,
    active: true,
    generation: 0
  }
  const cancel = Effect.sync(() => {
    state = { ...state, active: false, missed: 0 }
    Latch.openUnsafe(changed)
  })
  const restart = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    last = now
    state = { ...state, active: true, missed: 0, generation: state.generation + 1 }
    next = now + state.interval
    expires = state.cancelAfter > 0 ? now + state.cancelAfter : Infinity
    Latch.openUnsafe(changed)
  })
  yield* Effect.addFinalizer(() => cancel)
  yield* Effect.gen(function*() {
    // Unlike a fixed polling schedule, explicit changes replace the current deadline while activity resets the lease.
    while (true) {
      Latch.closeUnsafe(changed)
      if (!state.active) {
        yield* changed.await
        continue
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= expires) {
        yield* cancel
        continue
      }
      if (now >= next) {
        next += state.interval
        const missed = now - last > state.interval ? state.missed + 1 : state.missed
        state = { ...state, count: state.count + 1, missed }
        if (missed >= state.maxOut && (yield* onMissed(missed))) yield* cancel
        continue
      }
      yield* changed.await.pipe(Effect.timeoutOption(Math.min(next, expires) - now))
    }
  }).pipe(Effect.forkScoped)
  return {
    work: Effect.gen(function*() {
      last = yield* Clock.currentTimeMillis
      state = { ...state, missed: 0 }
    }),
    cancel,
    restart,
    change: (interval, cancelAfter = 0, maxOut = 2) =>
      Effect.gen(function*() {
        state = { ...state, interval, cancelAfter, maxOut }
        yield* restart
      }),
    state: Effect.sync(() => ({ ...state }))
  }
})
