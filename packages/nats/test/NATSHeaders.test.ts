import { describe, expect, it } from "@effect/vitest"
import { headers } from "@nats-io/nats-core"
import { Effect, Option } from "effect"
import * as NATSHeaders from "../src/NATSHeaders.ts"

describe("NATSHeaders", () => {
  it.effect("round trips trace context without replacing caller headers", () =>
    Effect.useSpan("nats.test.producer", { root: true }, (span) =>
      Effect.sync(() => {
        const existing = headers()
        existing.set("x-custom", "custom-value")

        const merged = NATSHeaders.mergeNatsHeaders(existing, NATSHeaders.encodeTraceContext(span))
        const decoded = Option.getOrThrow(NATSHeaders.decodeTraceContext(merged))

        expect(merged.get("x-custom")).toBe("custom-value")
        expect(decoded.traceId).toBe(span.traceId)
        expect(decoded.spanId).toBe(span.spanId)
        expect(decoded.sampled).toBe(span.sampled)
      })))

  it.effect("drops server-owned headers and keeps caller headers", () =>
    Effect.sync(() => {
      const existing = headers()
      existing.set("Nats-Request-Info", "{\"user\":\"forged\"}")
      existing.set("Nats-Trace-Hop", "4")
      existing.set("Nats-Trace-Origin-Account", "OTHER")
      existing.set("Nats-Trace-Dest", "trace.receiver")
      existing.set("x-app", "orders")

      const merged = NATSHeaders.mergeNatsHeaders(existing, headers())

      expect(merged.has("Nats-Request-Info")).toBe(false)
      expect(merged.has("Nats-Trace-Hop")).toBe(false)
      expect(merged.has("Nats-Trace-Origin-Account")).toBe(false)
      expect(merged.get("Nats-Trace-Dest")).toBe("trace.receiver")
      expect(merged.get("x-app")).toBe("orders")
    }))
})
