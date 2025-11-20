import * as Effect from "effect/Effect"

export type NATSErrorConstructor<E> = new(args: { reason: string; cause?: unknown }) => E

export const wrapAsync =
  <E>(ErrorClass: NATSErrorConstructor<E>) =>
  <A>(promise: (signal: AbortSignal) => Promise<A>, errorReason: string): Effect.Effect<A, E> =>
    Effect.tryPromise({
      try: async (signal) => promise(signal),
      catch: (error) => new ErrorClass({ reason: errorReason, cause: error })
    })

export const wrap =
  <E>(ErrorClass: NATSErrorConstructor<E>) => <A>(fn: () => A, errorReason: string): Effect.Effect<A, E> =>
    Effect.try({
      try: fn,
      catch: (error) => new ErrorClass({ reason: errorReason, cause: error })
    })
