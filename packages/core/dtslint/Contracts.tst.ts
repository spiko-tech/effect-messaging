import type * as Effect from "effect/Effect"
import { describe, expect, it } from "tstyche"
import type { Publisher, PublisherError, Subscriber, SubscriberError } from "../src/index.js"

interface HandlerDependency {
  readonly _tag: "HandlerDependency"
}

interface MessageService {
  readonly _tag: "LegacyMessageService"
}

declare const publisher: Publisher.Publisher<string>
declare const subscriber: Subscriber.Subscriber<"Ack", MessageService>
declare const publisherIdentityRequired: {} extends Pick<Publisher.Publisher<string>, typeof Publisher.TypeId> ? false
  : true
declare const subscriberIdentityRequired: {} extends Pick<
  Subscriber.Subscriber<"Ack", MessageService>,
  typeof Subscriber.TypeId
> ? false :
  true

describe("core contracts", () => {
  it("keeps the nominal publisher contract", () => {
    expect(publisherIdentityRequired).type.toBe<true>()
    expect(publisher.publish("message")).type.toBe<Effect.Effect<void, PublisherError.PublisherError>>()
  })

  it("keeps context-provided subscriber handlers", () => {
    const app = undefined as unknown as Effect.Effect<"Ack", "handler-error", HandlerDependency | MessageService>
    const subscribed = subscriber.subscribe(app)

    expect(subscriberIdentityRequired).type.toBe<true>()
    expect(subscribed).type.toBe<Effect.Effect<void, SubscriberError.SubscriberError, HandlerDependency>>()
    expect(subscriber.healthCheck).type.toBe<Effect.Effect<void, SubscriberError.SubscriberError>>()
  })
})
