import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Redacted } from "effect"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import { expectFailure } from "./assertions.ts"

describe("AMQP Node transport configuration", () => {
  it.effect("does not expose credentials from malformed URLs", () =>
    Effect.gen(function*() {
      const secret = "never-log-this-password"
      const url = `amqp://guest:${secret}@[invalid]/`
      for (const input of [url, Redacted.make(url)]) {
        const result = yield* AMQPNodeConnection.make(input).pipe(Effect.scoped, Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).not.toContain(secret)
      }
    }))

  it.effect("rejects unsupported protocols before dialing", () =>
    AMQPNodeConnection.make("https://localhost").pipe(
      Effect.scoped,
      Effect.exit,
      Effect.map((exit) => expectFailure(exit, { _tag: "AMQPConnectionError", permanent: true }))
    ))

  it.effect("validates endpoint bounds before dialing", () =>
    AMQPNodeConnection.make({ hostname: "localhost", port: 65536 }).pipe(
      Effect.scoped,
      Effect.exit,
      Effect.map((exit) => expectFailure(exit, { _tag: "AMQPConnectionError", permanent: true }))
    ))
})
