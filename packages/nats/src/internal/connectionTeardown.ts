import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { settleWithin } from "./settleWithin.js"

/** The part of a NATS connection this module needs, kept narrow so it can be stubbed in tests. */
export interface Closeable {
  readonly isClosed: () => boolean
  readonly isDraining: () => boolean
  readonly drain: () => Promise<void>
  readonly close: () => Promise<void>
  readonly closed: () => Promise<void | Error>
}

/** Whatever remains of the budget goes to the final close, but never less than this. */
const CLOSE_GRACE_MILLIS = 1_000

type Outcome = "settled" | "timedOut" | { readonly cause: unknown }

const settle = (promise: Promise<unknown>): Promise<Outcome> => promise.then(() => "settled", (cause) => ({ cause }))

/**
 * Drains the connection within `budget`, closing it outright once the budget elapses or the drain
 * fails.
 *
 * `drain()` unsubscribes, then waits for a PING/PONG round trip before it closes. Handlers are never
 * waited for. What holds it open is a server that has gone silent, a lost link with reconnects
 * disabled, or a reconnect cycle rejecting the queued pong. Without a bound any of those strands
 * process shutdown until the supervisor resorts to SIGKILL.
 */
export const closeConnection = (connection: Closeable, budget: Duration.Duration): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (connection.isClosed()) {
      return yield* Effect.logDebug("NATSConnection: connection already closed")
    }
    const deadline = Date.now() + Duration.toMillis(budget)

    // A drain the application started itself would make ours reject: wait for that one instead.
    const drain = connection.isDraining() ? connection.closed() : connection.drain()
    const drained = yield* settleWithin(settle(drain), deadline - Date.now(), "timedOut")
    if (drained === "settled") {
      return yield* Effect.logDebug("NATSConnection: connection drained")
    }
    yield* drained === "timedOut"
      ? Effect.logWarning(
        `NATSConnection: connection did not drain within ${Duration.format(budget)}, closing it instead`
      )
      : Effect.logWarning("NATSConnection: draining the connection failed, closing it instead", drained.cause)

    const closeBudget = Math.max(deadline - Date.now(), CLOSE_GRACE_MILLIS)
    const closed = yield* settleWithin(settle(connection.close()), closeBudget, "timedOut")
    if (closed === "settled") {
      return yield* Effect.logDebug("NATSConnection: connection closed")
    }
    yield* closed === "timedOut"
      ? Effect.logError(
        `NATSConnection: connection did not close within ${Duration.format(Duration.millis(closeBudget))}`
      )
      : Effect.logError("NATSConnection: closing the connection failed", closed.cause)
  }).pipe(Effect.withSpan("NATSConnection.closeConnection"))
