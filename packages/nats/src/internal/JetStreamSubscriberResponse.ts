import type * as JetStreamSubscriberResponse from "../JetStreamSubscriberResponse.js"

/** @internal */
export const TypeId: JetStreamSubscriberResponse.TypeId = Symbol.for(
  "@effect-messaging/nats/JetStreamSubscriberResponse"
) as JetStreamSubscriberResponse.TypeId

class AckImpl implements JetStreamSubscriberResponse.Ack {
  readonly [TypeId]: JetStreamSubscriberResponse.TypeId = TypeId
  readonly _tag = "Ack" as const
}

class NakImpl implements JetStreamSubscriberResponse.Nak {
  readonly [TypeId]: JetStreamSubscriberResponse.TypeId = TypeId
  readonly _tag = "Nak" as const

  constructor(readonly millis?: number) {}
}

class TermImpl implements JetStreamSubscriberResponse.Term {
  readonly [TypeId]: JetStreamSubscriberResponse.TypeId = TypeId
  readonly _tag = "Term" as const

  constructor(readonly reason?: string) {}
}

/** @internal */
export const ack = (): JetStreamSubscriberResponse.JetStreamSubscriberResponse => new AckImpl()

/** @internal */
export const nak = (
  options?: JetStreamSubscriberResponse.NakOptions
): JetStreamSubscriberResponse.JetStreamSubscriberResponse => new NakImpl(options?.millis)

/** @internal */
export const term = (
  options?: JetStreamSubscriberResponse.TermOptions
): JetStreamSubscriberResponse.JetStreamSubscriberResponse => new TermImpl(options?.reason)

/** @internal */
export const isJetStreamSubscriberResponse = (
  u: unknown
): u is JetStreamSubscriberResponse.JetStreamSubscriberResponse => typeof u === "object" && u !== null && TypeId in u
