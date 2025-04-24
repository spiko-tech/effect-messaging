import type { Channel, Connection } from "amqplib"
import type { SubscriptionRef } from "effect"
import { Effect, Option, Stream } from "effect"

/** @internal */
const eventStream =
  (eventName: string) => <T extends Connection | Channel>(ref: SubscriptionRef.SubscriptionRef<Option.Option<T>>) =>
    ref.changes.pipe(
      Stream.flatMap(
        (target) => {
          if (Option.isNone(target)) {
            return Stream.never
          } else {
            return Stream.asyncPush<unknown>((emit) =>
              Effect.sync(() => {
                target.value.addListener(eventName, emit.single)
              })
            )
          }
        },
        { concurrency: "unbounded" }
      )
    )

/** @internal */
export const closeStream = eventStream("close")

/** @internal */
export const errorStream = eventStream("error")
