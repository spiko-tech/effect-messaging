/**
 * @since 0.1.0
 */
import * as NATSCore from "@nats-io/nats-core"
import * as Headers from "effect/http/Headers"
import * as HttpTraceContext from "effect/http/HttpTraceContext"
import * as Option from "effect/Option"
import type * as Tracer from "effect/Tracer"

/** @internal */
export const natsHeadersToEffectHeaders = (msgHdrs: NATSCore.MsgHdrs): Headers.Headers => {
  const entries: Array<[string, string]> = []
  for (const [key, values] of msgHdrs) {
    for (const value of values) {
      entries.push([key, value])
    }
  }
  return Headers.fromInput(entries)
}

/** @internal */
export const effectHeadersToNatsHeaders = (hdrs: Headers.Headers): NATSCore.MsgHdrs => {
  const msgHdrs = NATSCore.headers()
  for (const [key, value] of Object.entries(hdrs)) {
    if (key !== Headers.TypeId.toString()) {
      msgHdrs.set(key, value)
    }
  }
  return msgHdrs
}

/**
 * Headers the server stamps itself. A client value is not an identity or a hop
 * count. `Nats-Trace-Dest` stays: callers set that subject on purpose, and the
 * server checks publish permission for it.
 *
 * @internal
 * @since 1.0.0
 */
export const serverOwnedHeaders: Array<string> = [
  "Nats-Request-Info",
  "Nats-Trace-Hop",
  "Nats-Trace-Origin-Account"
]

/**
 * Removes server-owned headers from `msgHdrs` in place.
 *
 * @internal
 * @since 1.0.0
 */
export const omitServerOwnedHeaders = (msgHdrs: NATSCore.MsgHdrs): NATSCore.MsgHdrs => {
  for (const key of serverOwnedHeaders) {
    msgHdrs.delete(key)
  }
  return msgHdrs
}

/**
 * Removes server-owned headers from a publish or request options object, in place.
 *
 * @internal
 * @since 1.0.0
 */
export const omitOwnedHeaders = (value: { readonly headers?: NATSCore.MsgHdrs } | undefined): void => {
  if (value?.headers) omitServerOwnedHeaders(value.headers)
}

/** @internal */
export const mergeNatsHeaders = (
  existing: NATSCore.MsgHdrs | undefined,
  toMerge: NATSCore.MsgHdrs
): NATSCore.MsgHdrs => {
  const result = existing ?? NATSCore.headers()
  omitServerOwnedHeaders(result)
  for (const [key, values] of toMerge) {
    for (const value of values) {
      result.append(key, value)
    }
  }
  return omitServerOwnedHeaders(result)
}

/** @internal */
export const encodeTraceContext = (span: Tracer.Span): NATSCore.MsgHdrs => {
  const traceHeaders = HttpTraceContext.toHeaders(span)
  return effectHeadersToNatsHeaders(traceHeaders)
}

/** @internal */
export const decodeTraceContext = (msgHdrs: NATSCore.MsgHdrs): Option.Option<Tracer.ExternalSpan> => {
  const effectHeaders = natsHeadersToEffectHeaders(msgHdrs)
  return HttpTraceContext.fromHeaders(effectHeaders)
}

/** @internal */
export const decodeTraceContextOptional = (
  msgHdrs: Option.Option<NATSCore.MsgHdrs>
): Option.Option<Tracer.ExternalSpan> =>
  msgHdrs.pipe(
    Option.flatMap(decodeTraceContext)
  )
