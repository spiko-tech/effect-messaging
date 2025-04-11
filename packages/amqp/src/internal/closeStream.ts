import type { Channel, Connection } from "amqplib"
import type { SubscriptionRef } from "effect"
import { Effect, Option, Stream } from "effect"

/** @internal */
export const closeStream = <T extends Connection | Channel>(ref: SubscriptionRef.SubscriptionRef<Option.Option<T>>) =>
  ref.changes.pipe(
    Stream.flatMap(
      (target) => {
        if (Option.isNone(target)) {
          return Stream.never
        } else {
          return Stream.asyncPush<unknown>((emit) =>
            Effect.sync(() => {
              target.value.addListener("close", emit.single)
            })
          )
        }
      },
      { concurrency: "unbounded" }
    )
  )
