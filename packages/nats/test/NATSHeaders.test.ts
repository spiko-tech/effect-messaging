import { describe, expect, it } from "@effect/vitest"
import { headers } from "@nats-io/nats-core"
import { Effect, Option } from "effect"
import * as NATSHeaders from "../src/NATSHeaders.js"

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
})
