/**
 * @since 0.1.0
 */
import * as NATSCore from "@nats-io/nats-core"
import * as TransportNode from "@nats-io/transport-node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSConnection")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSConnection {
  readonly [TypeId]: TypeId
  readonly publish: (
    ...params: Parameters<NATSCore.NatsConnection["publish"]>
  ) => Effect.Effect<ReturnType<NATSCore.NatsConnection["publish"]>, NATSError.NATSConnectionError, void>
  readonly publishMessage: (
    ...params: Parameters<NATSCore.NatsConnection["publishMessage"]>
  ) => Effect.Effect<ReturnType<NATSCore.NatsConnection["publishMessage"]>, NATSError.NATSConnectionError, void>
  readonly respondMessage: (
    ...params: Parameters<NATSCore.NatsConnection["respondMessage"]>
  ) => Effect.Effect<ReturnType<NATSCore.NatsConnection["respondMessage"]>, NATSError.NATSConnectionError, void>
  readonly request: (
    ...params: Parameters<NATSCore.NatsConnection["request"]>
  ) => Effect.Effect<Awaited<ReturnType<NATSCore.NatsConnection["request"]>>, NATSError.NATSConnectionError, void>
  // readonly subscribe: (
  //   ...params: Parameters<NATSCore.NatsConnection["subscribe"]>
  // ) => Effect.Effect<Stream.Stream<NATSCore.Msg, NATSError.NATSConnectionError>>

  /** @internal */
  readonly close: Effect.Effect<void, never, never>
  /** @internal */
  readonly drain: Effect.Effect<void, never, never>
  /** @internal */
  readonly nc: NATSCore.NatsConnection
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSConnection = Context.GenericTag<NATSConnection>("@effect-messaging/nats/NATSConnection")

/** @internal */
const wrap = <A>(
  promise: (signal: AbortSignal) => Promise<A>,
  errorReason: string
): Effect.Effect<A, NATSError.NATSConnectionError> =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => new NATSError.NATSConnectionError({ reason: errorReason, cause: error })
  })

/** @internal */
const make = (
  connect: () => Promise<NATSCore.NatsConnection>
): Effect.Effect<NATSConnection, NATSError.NATSConnectionError, Scope.Scope> =>
  Effect.gen(function*() {
    const nc = yield* wrap(connect, "Failed to create NATS connection")

    const connection: NATSConnection = {
      [TypeId]: TypeId,
      publish: (...params) => wrap(async () => nc.publish(...params), "Failed to publish message"),
      publishMessage: (...params) => wrap(async () => nc.publishMessage(...params), "Failed to publish message"),
      respondMessage: (...params) => wrap(async () => nc.respondMessage(...params), "Failed to respond to message"),
      request: (...params) => wrap(() => nc.request(...params), "Failed to request message"),
      close: Effect.promise(() => nc.close()),
      drain: Effect.promise(() => nc.drain()),
      nc
    }

    yield* Effect.addFinalizer(() => connection.drain)

    return connection
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layerWebSocket = (options: NATSCore.ConnectionOptions): Layer.Layer<
  NATSConnection,
  NATSError.NATSConnectionError
> => Layer.scoped(NATSConnection, make(() => NATSCore.wsconnect(options)))

/**
 * @since 0.1.0
 * @category Layers
 */
export const layerNode = (options: TransportNode.NodeConnectionOptions): Layer.Layer<
  NATSConnection,
  NATSError.NATSConnectionError
> => Layer.scoped(NATSConnection, make(() => TransportNode.connect(options)))
