import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"

const positiveBudgets = [
  "timeout",
  "pingInterval",
  "maxPingOut",
  "pendingLimit",
  "maxBufferedBytes",
  "maxPendingCommands",
  "maxControlLine",
  "drainTimeout"
] as const
const cases: Array<{ readonly label: string; readonly options: NATSOptions.ConnectionOptions }> = [
  ...positiveBudgets.flatMap((key) =>
    [0, -1, NaN, Infinity].map((value) => ({
      label: `${key}=${value}`,
      options: { [key]: value }
    }))
  ),
  ...["reconnectTimeWait", "reconnectJitter", "reconnectJitterTLS"].flatMap((key) =>
    [-1, NaN, Infinity].map((value) => ({
      label: `${key}=${value}`,
      options: { [key]: value }
    }))
  ),
  ...["maxPingOut", "pendingLimit", "maxBufferedBytes", "maxPendingCommands", "maxControlLine"].map((key) => ({
    label: `${key}=1.5`,
    options: { [key]: 1.5 }
  })),
  ...[-2, 1.5, NaN, Infinity].map((value) => ({
    label: `maxReconnectAttempts=${value}`,
    options: { maxReconnectAttempts: value }
  })),
  ...[0, 65536, 1.5].map((value) => ({ label: `port=${value}`, options: { port: value } })),
  { label: "empty server pool", options: { servers: [] } },
  { label: "servers combined with port", options: { servers: "localhost:4222", port: 4222 } },
  { label: "whitespace in inbox prefix", options: { inboxPrefix: "bad prefix" } },
  { label: "wildcard inbox prefix", options: { inboxPrefix: "bad.*" } },
  { label: "trailing dot inbox prefix", options: { inboxPrefix: "bad." } }
]

describe("Connection option validation before acquiring transport", () => {
  it.effect.each(cases)("rejects $label without opening a socket", ({ options }) =>
    Effect.gen(function*() {
      let opened = false
      const factory: NATSConnection.SocketFactory = () =>
        Effect.sync(() => {
          opened = true
          throw new Error("Invalid connection configuration reached the transport")
        })
      const error = yield* NATSConnection.make(factory, options).pipe(Effect.scoped, Effect.flip)
      expect(error._tag).toBe("NATSConnectionError")
      expect(error.code).toBe("invalid_argument")
      expect(opened).toBe(false)
    }))
})
