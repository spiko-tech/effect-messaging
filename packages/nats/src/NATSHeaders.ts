/**
 * @since 0.1.0
 */
import * as Headers from "@effect/platform/Headers"
import * as HttpTraceContext from "@effect/platform/HttpTraceContext"
import * as NATSCore from "@nats-io/nats-core"
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
    if (key !== Headers.HeadersTypeId.toString()) {
      msgHdrs.set(key, value)
    }
  }
  return msgHdrs
}

/** @internal */
export const mergeNatsHeaders = (
  existing: NATSCore.MsgHdrs | undefined,
  toMerge: NATSCore.MsgHdrs
): NATSCore.MsgHdrs => {
  const result = existing ?? NATSCore.headers()
  for (const [key, values] of toMerge) {
    for (const value of values) {
      result.append(key, value)
    }
  }
  return result
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
