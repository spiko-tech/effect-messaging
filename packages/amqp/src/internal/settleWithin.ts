import * as Effect from "effect/Effect"

// setTimeout treats larger delays as 1 ms
const MAX_TIMER_MILLIS = 2_147_483_647

/**
 * Waits for an already-started promise, resolving `onTimeout` instead once `millis` elapses. The
 * promise must never reject. An infinite or oversized budget waits without a timer.
 *
 * Raced at the promise level rather than with `Effect.timeout`, because this runs from scope
 * finalizers: there the fiber is uninterruptible, so a timeout cannot interrupt the wait, and an
 * interrupt reaching the fiber mid-teardown would be forwarded to the children of an Effect-level
 * race, ending the wait early and skipping the close that follows. A promise race is affected by
 * neither. The timer is cleared either way so a settled teardown never holds the event loop open.
 *
 * @internal
 */
export const settleWithin = <A>(promise: Promise<A>, millis: number, onTimeout: A): Effect.Effect<A> =>
  Effect.promise(() => {
    if (!(millis <= MAX_TIMER_MILLIS)) {
      return promise
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      promise,
      new Promise<A>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), Math.max(millis, 0))
      })
    ]).finally(() => clearTimeout(timer))
  })
