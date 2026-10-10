/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamLister")
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamLister<T, E> {
  readonly [TypeId]: TypeId
  readonly next: () => Effect.Effect<Array<T>, E>
  readonly stream: Stream.Stream<T, E>
}
/** @internal */
export const make = <T, E>(
  page: (offset: number) => Effect.Effect<readonly [ReadonlyArray<T>, Option.Option<number>], E>
): JetStreamLister<T, E> => {
  let cursor: Option.Option<number> = Option.some(0)
  return {
    [TypeId]: TypeId,
    next: Effect.fnUntraced(function*() {
      if (Option.isNone(cursor)) return []
      const [values, next] = yield* page(cursor.value)
      cursor = next
      return Array.from(values)
    }),
    stream: Stream.paginate(0, page)
  }
}
/** @internal */
export const mapError = <T, E, E2>(lister: JetStreamLister<T, E>, f: (error: E) => E2): JetStreamLister<T, E2> => ({
  [TypeId]: TypeId,
  next: () => lister.next().pipe(Effect.mapError(f)),
  stream: lister.stream.pipe(Stream.mapError(f))
})
