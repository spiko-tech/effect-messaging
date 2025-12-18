/**
 * @since 0.3.0
 */
import * as Publisher from "@effect-messaging/core/Publisher"
import * as PublisherError from "@effect-messaging/core/PublisherError"
import type * as NATSCore from "@nats-io/nats-core"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Tracer from "effect/Tracer"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"
import * as NATSHeaders from "./NATSHeaders.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSPublisher")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface NATSPublishMessage {
  subject: string
  payload: NATSCore.Payload
  options?: NATSCore.PublishOptions
}

/**
 * @category models
 * @since 0.3.0
 */
export interface NATSPublisher extends Publisher.Publisher<NATSPublishMessage> {
  readonly [TypeId]: TypeId
}

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const

/** @internal */
const publishEffect = (
  connection: NATSConnection.NATSConnection,
  message: NATSPublishMessage,
  span: Tracer.Span
) => {
  const headers = NATSHeaders.mergeNatsHeaders(message.options?.headers, NATSHeaders.encodeTraceContext(span))

  return connection.publish(
    message.subject,
    message.payload,
    { ...message.options, headers }
  )
}

/** @internal */
const publish = (
  connection: NATSConnection.NATSConnection,
  connectionInfo: NATSCore.ServerInfo,
  retrySchedule: Schedule.Schedule<unknown, NATSError.NATSConnectionError>
) =>
(message: NATSPublishMessage): Effect.Effect<void, PublisherError.PublisherError, never> =>
  Effect.useSpan(
    `nats.publish ${message.subject}`,
    {
      kind: "producer",
      captureStackTrace: false,
      attributes: {
        [ATTR_SERVER_ADDRESS]: connectionInfo.host,
        [ATTR_SERVER_PORT]: connectionInfo.port,
        [ATTR_MESSAGING_SYSTEM]: "nats",
        [ATTR_MESSAGING_OPERATION_NAME]: "publish",
        [ATTR_MESSAGING_OPERATION_TYPE]: "send",
        [ATTR_MESSAGING_DESTINATION_NAME]: message.subject
      }
    },
    (span) =>
      publishEffect(connection, message, span).pipe(
        Effect.retry(retrySchedule),
        Effect.catchTag(
          "NATSConnectionError",
          (error) =>
            Effect.fail(new PublisherError.PublisherError({ reason: "Failed to publish message", cause: error }))
        )
      )
  )

/**
 * @category constructors
 * @since 0.3.0
 */
export interface NATSPublisherConfig {
  readonly retrySchedule?: Schedule.Schedule<unknown, NATSError.NATSConnectionError>
}

/**
 * @category constructors
 * @since 0.3.0
 */
export const make = (
  config?: NATSPublisherConfig
): Effect.Effect<
  NATSPublisher,
  NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection

    // Get connection info for span attributes
    const connectionInfo = yield* Option.match(connection.info, {
      onNone: () => Effect.fail(new NATSError.NATSConnectionError({ reason: "Connection info not available" })),
      onSome: Effect.succeed
    })

    const publisher: NATSPublisher = {
      [TypeId]: TypeId,
      [Publisher.TypeId]: Publisher.TypeId,
      publish: publish(connection, connectionInfo, config?.retrySchedule ?? Schedule.stop)
    }

    return publisher
  })
