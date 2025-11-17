/**
 * @since 0.1.0
 */
import * as JetStream from "@nats-io/jetstream"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSJetStreamClient")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Client
 *
 * @category models
 * @since 0.1.0
 */
export interface NATSJetStreamClient {
  readonly [TypeId]: TypeId
  readonly apiPrefix: string
  readonly publish: (
    ...params: Parameters<JetStream.JetStreamClient["publish"]>
  ) => Effect.Effect<Awaited<ReturnType<JetStream.JetStreamClient["publish"]>>, NATSError.NATSJetStreamError, void>

  /** @internal */
  readonly js: JetStream.JetStreamClient
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSJetStreamClient = Context.GenericTag<NATSJetStreamClient>("@effect-messaging/nats/NATSJetStreamClient")

/** @internal */
const wrap = <A>(promise: (signal: AbortSignal) => Promise<A> | A, errorReason: string) =>
  Effect.tryPromise({
    try: async (signal) => promise(signal),
    catch: (error) => new NATSError.NATSJetStreamError({ reason: errorReason, cause: error })
  })

/** @internal */
const makeJetStreamClient = (options: JetStream.JetStreamOptions = {}): Effect.Effect<
  NATSJetStreamClient,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const { nc } = yield* NATSConnection.NATSConnection
    const js = yield* wrap(() => JetStream.jetstream(nc, options), "Failed to create JetStream client")

    const client: NATSJetStreamClient = {
      [TypeId]: TypeId,
      apiPrefix: js.apiPrefix,
      publish: (...params: Parameters<JetStream.JetStreamClient["publish"]>) =>
        wrap(async () => js.publish(...params), `Failed to publish message`),
      js
    }

    return client
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: JetStream.JetStreamOptions = {}): Layer.Layer<
  NATSJetStreamClient,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> => Layer.scoped(NATSJetStreamClient, makeJetStreamClient(options))
