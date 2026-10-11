import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option } from "effect"
import * as NATSBench from "../src/NATSBench.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSMetric from "../src/NATSMetric.ts"

const connection = NATSConnection.layerNode()
describe("Exact upstream benchmark helper laws", () => {
  it.live("bench - no opts toss", () =>
    Effect.gen(function*() {
      const client = yield* NATSConnection.NATSConnection
      const error = yield* NATSBench.make(client, {}).pipe(Effect.flip)
      expect(error.reason).toBe("no options selected")
    }).pipe(Effect.provide(connection)))

  it.live.each([false, true])(
    "benchmark cancellation releases subscriptions, callbacks=%s",
    (callbacks) =>
      Effect.gen(function*() {
        const client = yield* NATSConnection.NATSConnection
        const subject = yield* client.createInbox
        const ready = yield* Deferred.make<void>()
        const tracked: NATSConnection.NATSConnection = {
          ...client,
          subscribe: (...args) => client.subscribe(...args).pipe(Effect.tap(() => Deferred.succeed(ready, undefined)))
        }
        const benchmark = yield* NATSBench.make(tracked, { sub: true, callbacks, msgs: 5, subject })
        const running = yield* benchmark.run.pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        yield* client.flush
        yield* Fiber.interrupt(running)
        yield* client.flush
        const error = yield* client.request(subject).pipe(Effect.flip)
        expect(error.code).toBe("no_responders")
        expect(yield* client.isClosed).toBe(false)
        expect(yield* client.closed.pipe(Effect.timeoutOption("1 millis"))).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(connection))
  )

  it.live.each([
    { label: "pubsub", pub: true, sub: true, callbacks: true },
    { label: "pubsub async", pub: true, sub: true, callbacks: false },
    { label: "req", req: true, rep: true, callbacks: true },
    { label: "req async", req: true, rep: true, callbacks: true, asyncRequests: true }
  ])("bench - $label", (options) =>
    Effect.gen(function*() {
      const client = yield* NATSConnection.NATSConnection
      const subject = yield* client.createInbox
      const benchmark = yield* NATSBench.make(client, { ...options, msgs: 5, size: 8, subject })
      const metrics = yield* benchmark.run
      expect(metrics).toHaveLength(3)
      expect(metrics.map((metric) => metric.name).sort()).toEqual(
        options.pub ? ["pub", "pubsub", "sub"] : ["rep", "req", "reqrep"]
      )
      for (const metric of metrics) {
        expect(metric.payload).toBe(8)
        expect(metric.msgs).toBe(metric.name === "pubsub" || metric.name === "reqrep" ? 10 : 5)
        expect(metric.lang).not.toBe("")
        expect(metric.version).not.toBe("")
        expect(NATSMetric.toString(metric)).not.toBe("")
        expect(NATSMetric.header().split(",")).toHaveLength(9)
        const rows = NATSMetric.toCsv(metric).split("\n")
        expect(rows).toHaveLength(2)
        expect(rows[0].split(",")).toHaveLength(9)
        expect(metric.bytes).toBeGreaterThan(0)
      }
    }).pipe(Effect.provide(connection)))
})
