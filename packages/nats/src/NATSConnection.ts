/**
 * @since 0.1.0
 */
import * as NATSCore from "@nats-io/nats-core"
import * as TransportNode from "@nats-io/transport-node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as utils from "./internal/utils.js"
import * as NATSError from "./NATSError.js"
import * as NATSMessage from "./NATSMessage.js"
import * as NATSSubscription from "./NATSSubscription.js"

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
 * Represents a NATS Connection
 *
 * @category models
 * @since 0.1.0
 */
export interface NATSConnection {
  readonly [TypeId]: TypeId
  info: Option.Option<NATSCore.ServerInfo>
  readonly publish: (
    ...params: Parameters<NATSCore.NatsConnection["publish"]>
  ) => Effect.Effect<void, NATSError.NATSConnectionError>
  readonly publishMessage: (
    ...params: Parameters<NATSCore.NatsConnection["publishMessage"]>
  ) => Effect.Effect<void, NATSError.NATSConnectionError>
  readonly respondMessage: (
    ...params: Parameters<NATSCore.NatsConnection["respondMessage"]>
  ) => Effect.Effect<boolean, NATSError.NATSConnectionError>
  readonly request: (
    ...params: Parameters<NATSCore.NatsConnection["request"]>
  ) => Effect.Effect<NATSMessage.NATSMessage, NATSError.NATSConnectionError>
  readonly subscribe: (
    ...params: Parameters<NATSCore.NatsConnection["subscribe"]>
  ) => Effect.Effect<NATSSubscription.NATSSubscription, NATSError.NATSConnectionError>
  readonly flush: Effect.Effect<void, NATSError.NATSConnectionError>
  readonly requestMany: (
    ...params: Parameters<NATSCore.NatsConnection["requestMany"]>
  ) => Effect.Effect<
    Stream.Stream<NATSMessage.NATSMessage, NATSError.NATSConnectionError>,
    NATSError.NATSConnectionError
  >
  readonly getServer: Effect.Effect<string, NATSError.NATSConnectionError>
  readonly status: Effect.Effect<
    Stream.Stream<NATSCore.Status, NATSError.NATSConnectionError>,
    NATSError.NATSConnectionError
  >
  readonly stats: Effect.Effect<NATSCore.Stats, NATSError.NATSConnectionError>
  readonly rtt: Effect.Effect<number, NATSError.NATSConnectionError>

  /** @internal */
  readonly nc: NATSCore.NatsConnection
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSConnection = Context.GenericTag<NATSConnection>("@effect-messaging/nats/NATSConnection")

const wrapAsync = utils.wrapAsync(NATSError.NATSConnectionError)
const wrap = utils.wrap(NATSError.NATSConnectionError)

/** @internal */
const make = (
  connect: () => Promise<NATSCore.NatsConnection>
): Effect.Effect<NATSConnection, NATSError.NATSConnectionError, Scope.Scope> =>
  Effect.gen(function*() {
    const nc = yield* wrapAsync(connect, "Failed to create NATS connection")

    const connection: NATSConnection = {
      [TypeId]: TypeId,
      info: Option.fromNullable(nc.info),
      publish: (...params) => wrap(() => nc.publish(...params), "Failed to publish message"),
      publishMessage: (...params) => wrap(() => nc.publishMessage(...params), "Failed to publish message"),
      respondMessage: (...params) => wrap(() => nc.respondMessage(...params), "Failed to respond to message"),
      request: (...params) =>
        wrapAsync(() => nc.request(...params), "Failed to request message").pipe(
          Effect.map(NATSMessage.make)
        ),
      subscribe: (...params) =>
        wrap(() => nc.subscribe(...params), `Failed to subscribe to subject ${params[0]}`)
          .pipe(Effect.map(NATSSubscription.make)),
      flush: wrapAsync(() => nc.flush(), "Failed to flush"),
      requestMany: (...params) =>
        wrapAsync(() => nc.requestMany(...params), "Failed to request many messages").pipe(
          Effect.map((asyncIterable) =>
            Stream.fromAsyncIterable(
              asyncIterable,
              (error) =>
                new NATSError.NATSConnectionError({
                  reason: "An error occurred in requestMany async iterable",
                  cause: error
                })
            ).pipe(Stream.map(NATSMessage.make))
          )
        ),
      getServer: wrap(() => nc.getServer(), "Failed to get server"),
      status: wrap(
        () =>
          Stream.fromAsyncIterable(
            nc.status(),
            (error) =>
              new NATSError.NATSConnectionError({ reason: "An error occurred in status async iterable", cause: error })
          ),
        "Failed to get status stream"
      ),
      stats: wrap(() => nc.stats(), "Failed to get stats"),
      rtt: wrapAsync(() => nc.rtt(), "Failed to measure round-trip time"),
      nc
    }

    yield* Effect.addFinalizer(() => Effect.promise(() => nc.drain()))

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
