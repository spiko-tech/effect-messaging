/**
 * Shared OpenTelemetry constants and helpers for subscriber implementations.
 *
 * @internal
 * @since 0.3.0
 */
import * as Cause from "effect/Cause"
import * as Predicate from "effect/Predicate"
import type * as Tracer from "effect/Tracer"

/**
 * Semantic convention attribute keys shared across all subscriber implementations.
 *
 * @since 0.3.0
 * @category otel attributes
 */
export const SpanAttributes = {
  SERVER_ADDRESS: "server.address",
  SERVER_PORT: "server.port",
  MESSAGING_DESTINATION_NAME: "messaging.destination.name",
  MESSAGING_OPERATION_NAME: "messaging.operation.name",
  MESSAGING_OPERATION_TYPE: "messaging.operation.type",
  MESSAGING_SYSTEM: "messaging.system",
  MESSAGING_MESSAGE_ID: "messaging.message.id"
} as const

/**
 * Sets standard error span attributes on a span from an error cause.
 *
 * Sets `error.type`, `error.stack`, and `error.message` attributes using
 * `Cause.squashWith` to extract meaningful error information.
 *
 * @since 0.3.0
 * @category otel helpers
 */
export const setErrorSpanAttributes = (span: Tracer.Span, cause: Cause.Cause<unknown>): void => {
  span.attribute(
    "error.type",
    String(Cause.squashWith(
      cause,
      (_) => Predicate.hasProperty(_, "_tag") ? _._tag : _ instanceof Error ? _.name : `${_}`
    ))
  )
  span.attribute("error.stack", Cause.pretty(cause))
  span.attribute(
    "error.message",
    String(Cause.squashWith(
      cause,
      (_) => Predicate.hasProperty(_, "reason") ? _.reason : _ instanceof Error ? _.message : `${_}`
    ))
  )
}
