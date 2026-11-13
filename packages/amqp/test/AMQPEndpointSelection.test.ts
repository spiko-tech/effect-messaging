import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import { broker, encode } from "./dependencies.ts"

describe("AMQP Effect-native endpoint selection", () => {
  it.live(
    "evaluates endpoint selection afresh on failed connection attempts and recovery",
    () =>
      Effect.gen(function*() {
        const selected: Array<number> = []
        const factory = Effect.suspend(() => {
          // Port zero is deliberately unreachable; no shared broker is stopped for this scenario.
          const port = selected.length % 2 === 0 ? 0 : broker.port
          selected.push(port)
          return NodeSocket.makeNet({ host: broker.hostname, port })
        })
        const connection = yield* AMQPConnection.make(factory, {
          username: broker.username,
          password: broker.password,
          heartbeat: 0,
          retryConnectionSchedule: Schedule.recurs(4)
        })
        const channel = yield* connection.createChannel({ confirm: true })
        const queue = yield* channel.assertQueue("", { exclusive: true })
        const generation = (yield* connection.state).generation
        expect(selected).toEqual([0, broker.port])
        yield* connection.reconnect
        expect(selected).toEqual([0, broker.port, 0, broker.port])
        expect((yield* connection.state).generation).toBeGreaterThan(generation)
        yield* channel.sendToQueue(queue, encode("selected endpoint"))
        const delivery = yield* channel.get(queue)
        expect(Option.isSome(delivery)).toBe(true)
        if (Option.isNone(delivery)) return
        expect(delivery.value.content).toEqual(encode("selected endpoint"))
        yield* channel.ack(delivery.value)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )
})
