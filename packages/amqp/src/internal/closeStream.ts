import type { Channel, ChannelModel } from "amqplib"
import { Effect, Option, Queue, Stream, SubscriptionRef } from "effect"

/** @internal */
const eventStream =
  (eventName: string) => <T extends ChannelModel | Channel>(ref: SubscriptionRef.SubscriptionRef<Option.Option<T>>) =>
    SubscriptionRef.changes(ref).pipe(
      Stream.flatMap(
        (target) => {
          if (Option.isNone(target)) {
            return Stream.never
          } else {
            return Stream.callback<unknown>((queue) =>
              Effect.sync(() => {
                target.value.addListener(eventName, (event: unknown) => Queue.offerUnsafe(queue, event))
                target.value.addListener("close", () => Queue.endUnsafe(queue))
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
