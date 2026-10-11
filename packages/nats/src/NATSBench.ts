/**
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as NATSConnection from "./NATSConnection.ts"
import * as NATSInbox from "./NATSInbox.ts"
import type * as NATSMessage from "./NATSMessage.ts"
import type * as NATSMetric from "./NATSMetric.ts"

/** @since 0.1.0 */
export interface Options {
  readonly callbacks?: boolean
  readonly msgs?: number
  readonly size?: number
  readonly subject?: string
  readonly asyncRequests?: boolean
  readonly pub?: boolean
  readonly sub?: boolean
  readonly rep?: boolean
  readonly req?: boolean
}
/** @since 0.1.0 */
export class BenchmarkError extends Schema.TaggedError<BenchmarkError>()("NATSBenchmarkError", {
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  /** @since 0.1.0 */
  override get message(): string {
    return this.reason
  }
}
/** @since 0.1.0 */
export interface Benchmark {
  readonly run: Effect.Effect<Array<NATSMetric.Metric>, BenchmarkError>
}
const Inputs = Schema.Struct({
  msgs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})

/** Acquire a repeatable benchmark. Every run owns its subscriptions and request fibers.
 * @since 0.1.0
 * @category constructors
 */
export const make = Effect.fn("NATSBench.make")(function*(connection: NATSConnection.NATSConnection, options: Options) {
  if (!options.pub && !options.sub && !options.req && !options.rep) {
    return yield* new BenchmarkError({ reason: "no options selected" })
  }
  const { msgs, size } = yield* Schema.decodeUnknownEffect(Inputs)({ msgs: options.msgs || 0, size: options.size || 0 })
    .pipe(
      Effect.mapError((cause) => new BenchmarkError({ reason: "Invalid benchmark options", cause }))
    )
  const subject = options.subject || (yield* NATSInbox.createInbox())
  const payload = new Uint8Array(size)
  const run = Effect.gen(function*() {
    const before = yield* connection.stats
    const marks = new Map<string, { start: number; stop: number }>()
    const workers: Array<Effect.Effect<void, unknown>> = []
    const subscribe = Effect.fnUntraced(function*(kind: "sub" | "rep") {
      let received = 0
      const done = yield* Deferred.make<void, unknown>()
      const handle = (message: NATSMessage.NATSMessage) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          if (received === 0) marks.set(kind, { start: now, stop: now })
          if (kind === "rep") yield* message.respond(payload)
          received++
          if (received === msgs) {
            const mark = marks.get(kind)
            if (mark) mark.stop = yield* Clock.currentTimeMillis
            yield* Deferred.succeed(done, undefined)
          }
        })
      const subscription = yield* connection.subscribe(subject, {
        max: msgs,
        ...(options.callbacks ?
          {
            callback: (failure: Option.Option<unknown>, message: Option.Option<NATSMessage.NATSMessage>) =>
              Option.isSome(failure) ? Deferred.fail(done, failure.value).pipe(Effect.asVoid) : Option.isSome(message) ?
                handle(message.value).pipe(
                  Effect.tapError((cause) => Deferred.fail(done, cause)),
                  Effect.orDie
                ) :
                undefined
          } :
          {})
      })
      yield* Effect.addFinalizer(() => subscription.unsubscribe().pipe(Effect.ignore))
      if (options.callbacks) workers.push(Deferred.await(done))
      else workers.push(subscription.stream.pipe(Stream.runForEach(handle)))
    })
    if (options.sub) yield* subscribe("sub")
    if (options.rep) yield* subscribe("rep")
    if (options.pub) {
      workers.push(Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        yield* Effect.forEach(Array.from({ length: msgs }), () => connection.publish(subject, payload), {
          discard: true
        })
        yield* connection.flush
        marks.set("pub", { start, stop: yield* Clock.currentTimeMillis })
      }))
    }
    if (options.req) {
      workers.push(Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        yield* Effect.forEach(
          Array.from({ length: msgs }),
          () => connection.request(subject, options.asyncRequests ? payload : undefined, { timeout: 20_000 }),
          {
            discard: true,
            concurrency: options.asyncRequests ? "unbounded" : 1
          }
        )
        marks.set("req", { start, stop: yield* Clock.currentTimeMillis })
      }))
    }
    const running = yield* Effect.forEach(workers, (worker) => worker.pipe(Effect.forkChild))
    yield* Effect.forEach(running, Fiber.join, { discard: true }).pipe(
      Effect.raceFirst(
        connection.closed.pipe(
          Effect.flatMap((failure) =>
            Effect.fail(
              Option.getOrElse(failure, () => new BenchmarkError({ reason: "Connection closed during benchmark" }))
            )
          )
        )
      )
    )
    yield* connection.flush
    const after = yield* connection.stats
    const inBytes = after.inBytes - before.inBytes
    const outBytes = after.outBytes - before.outBytes
    const metrics: Array<NATSMetric.Metric> = []
    const add = (name: string, start: number, stop: number, count: number, bytes: number) =>
      metrics.push({
        name,
        duration: stop - start,
        date: stop,
        payload: size,
        msgs: count,
        bytes,
        lang: "typescript-effect",
        version: "1.0.0-beta.0",
        asyncRequests: options.asyncRequests || false
      })
    const pub = marks.get("pub")
    const sub = marks.get("sub")
    const req = marks.get("req")
    const rep = marks.get("rep")
    if (pub && sub) add("pubsub", pub.start, sub.stop, msgs * 2, inBytes + outBytes)
    if (req && rep) add("reqrep", req.start, req.stop, msgs * 2, inBytes + outBytes)
    for (const [name, mark] of marks) {
      add(name, mark.start, mark.stop, msgs, name === "pub" ? outBytes : name === "sub" ? inBytes : inBytes + outBytes)
    }
    return metrics
  }).pipe(Effect.scoped, Effect.mapError((cause) => new BenchmarkError({ reason: "Benchmark failed", cause })))
  return { run } satisfies Benchmark
})
