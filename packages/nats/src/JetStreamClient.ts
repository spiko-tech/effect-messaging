/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as internal from "./internal/jetstreamServices.ts"
import type * as JetStreamBatch from "./JetStreamBatch.ts"
import type * as JetStreamConsumer from "./JetStreamConsumer.ts"
import type * as JetStreamFastIngest from "./JetStreamFastIngest.ts"
import type * as JetStreamManager from "./JetStreamManager.ts"
import type * as JetStreamStream from "./JetStreamStream.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSConnection from "./NATSConnection.ts"
import type * as NATSError from "./NATSError.ts"
import type * as NATSOptions from "./NATSOptions.ts"

/** @since 0.1.0 */
export const TypeId: typeof internal.ClientTypeId = internal.ClientTypeId
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamClient {
  readonly [TypeId]: TypeId
  readonly apiPrefix: string
  readonly publish: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<T.JetStreamPublishOptions>
  ) => Effect.Effect<T.PubAck, NATSError.JetStreamClientError>
  readonly startBatch: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<T.JetStreamPublishOptions>
  ) => Effect.Effect<JetStreamBatch.JetStreamBatch, NATSError.JetStreamClientError>
  readonly startFastIngest: (
    subject: string,
    payload: NATSOptions.Payload | undefined,
    options: JetStreamFastIngest.FastIngestOptions & Partial<T.JetStreamPublishOptions>
  ) => Effect.Effect<
    JetStreamFastIngest.FastIngest,
    NATSError.JetStreamClientError,
    Scope.Scope
  >
  readonly jetstreamManager: (checkAPI?: boolean) => Effect.Effect<
    JetStreamManager.JetStreamManager,
    NATSError.JetStreamClientError
  >
  readonly options: Effect.Effect<T.JetStreamOptions, NATSError.JetStreamClientError>
  readonly consumers: JetStreamConsumer.Consumers
  readonly streams: JetStreamStream.JetStreamStreams
}
/** @since 0.1.0 */
export const JetStreamClient = Context.Service<JetStreamClient>("@effect-messaging/nats/JetStreamClient")

/** @since 1.0.0 */
export const make = internal.makeClient
/** @since 0.1.0 */
export const layer = (options: T.JetStreamOptions = {}): Layer.Layer<
  JetStreamClient,
  never,
  NATSConnection.NATSConnection
> => Layer.effect(JetStreamClient, Effect.map(NATSConnection.NATSConnection, (connection) => make(connection, options)))
