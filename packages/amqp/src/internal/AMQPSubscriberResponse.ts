import type * as AMQPSubscriberResponse from "../AMQPSubscriberResponse.js"

/** @internal */
export const TypeId: AMQPSubscriberResponse.TypeId = Symbol.for(
  "@effect-messaging/amqp/AMQPSubscriberResponse"
) as AMQPSubscriberResponse.TypeId

class AckImpl implements AMQPSubscriberResponse.Ack {
  readonly [TypeId]: AMQPSubscriberResponse.TypeId = TypeId
  readonly _tag = "Ack" as const
}

class NackImpl implements AMQPSubscriberResponse.Nack {
  readonly [TypeId]: AMQPSubscriberResponse.TypeId = TypeId
  readonly _tag = "Nack" as const

  constructor(
    readonly allUpTo?: boolean,
    readonly requeue?: boolean
  ) {}
}

class RejectImpl implements AMQPSubscriberResponse.Reject {
  readonly [TypeId]: AMQPSubscriberResponse.TypeId = TypeId
  readonly _tag = "Reject" as const

  constructor(readonly requeue?: boolean) {}
}

/** @internal */
export const ack = (): AMQPSubscriberResponse.AMQPSubscriberResponse => new AckImpl()

/** @internal */
export const nack = (
  options?: AMQPSubscriberResponse.NackOptions
): AMQPSubscriberResponse.AMQPSubscriberResponse => new NackImpl(options?.allUpTo, options?.requeue)

/** @internal */
export const reject = (
  options?: AMQPSubscriberResponse.RejectOptions
): AMQPSubscriberResponse.AMQPSubscriberResponse => new RejectImpl(options?.requeue)

/** @internal */
export const isAMQPSubscriberResponse = (u: unknown): u is AMQPSubscriberResponse.AMQPSubscriberResponse =>
  typeof u === "object" && u !== null && TypeId in u
