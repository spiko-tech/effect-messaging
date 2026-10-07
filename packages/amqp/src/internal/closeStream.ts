import type { Channel, ChannelModel } from "amqplib"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"

/** @internal */
// Only unexpected closure triggers recovery; intentional shutdown just makes the resource unavailable.
export const resourceStates = new WeakMap<ChannelModel | Channel, "closed" | "shutdown">()

/** @internal */
export const trackResource = <T extends ChannelModel | Channel>(target: T): T => {
  target.once("close", () => {
    if (!resourceStates.has(target)) {
      resourceStates.set(target, "closed")
    }
  })
  // Protect against error events emitted before the monitoring stream attaches.
  target.on("error", () => {})
  return target
}

/** @internal */
const eventStream =
  (eventName: string) => <T extends ChannelModel | Channel>(ref: SubscriptionRef.SubscriptionRef<Option.Option<T>>) =>
    SubscriptionRef.changes(ref).pipe(
      Stream.flatMap(
        (target) => {
          if (Option.isNone(target)) {
            return Stream.empty
          } else {
            return Stream.callback<unknown>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const resource = target.value
                  const onEvent = (event: unknown) => {
                    if (eventName !== "close" || resourceStates.get(resource) !== "shutdown") {
                      Queue.offerUnsafe(queue, event)
                    }
                  }
                  const onClose = () => Queue.endUnsafe(queue)
                  const state = resourceStates.get(resource)
                  if (state !== undefined) {
                    if (eventName === "close" && state === "closed") {
                      Queue.offerUnsafe(queue, undefined)
                    }
                    Queue.endUnsafe(queue)
                  } else {
                    resource.addListener(eventName, onEvent)
                    resource.addListener("close", onClose)
                  }
                  return () => {
                    resource.removeListener(eventName, onEvent)
                    resource.removeListener("close", onClose)
                  }
                }),
                (removeListeners) => Effect.sync(removeListeners)
              )
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
