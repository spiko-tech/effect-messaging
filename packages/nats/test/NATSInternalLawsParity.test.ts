import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Duration, Effect, Fiber, Option, Queue, Schema, Semaphore, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import { isIP } from "node:net"
import * as JetStreamApi from "../src/internal/jetstreamApi.ts"
import { encodeCommand, encodePublish, Parser } from "../src/internal/protocol.ts"
import * as NATSAuth from "../src/NATSAuth.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSInbox from "../src/NATSInbox.ts"
import * as NATSMessage from "../src/NATSMessage.ts"
import * as Node from "../src/NATSNodeConnection.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { normalizeServer } from "../src/NATSWebSocketConnection.ts"
import { makeServer } from "./server.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const info = {
  server_id: "laws",
  server_name: "laws",
  version: "2.15.0",
  go: "test",
  host: "test",
  port: 4222,
  proto: 1,
  max_payload: 1024 * 1024,
  client_id: 1,
  headers: true
}
const harness = Effect.gen(function*() {
  const incoming = yield* Queue.make<Uint8Array, Socket.SocketError>()
  const commands: Array<string> = []
  let greeting: object = info
  const factory: NATSConnection.SocketFactory = () =>
    Effect.gen(function*() {
      Queue.offerUnsafe(incoming, encoder.encode("INFO " + JSON.stringify(greeting) + "\r\n"))
      const write: Socket.Writer["write"] = (chunk) =>
        Effect.sync(() => {
          if (Socket.isCloseEvent(chunk)) return
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk)
          commands.push(text)
          if (text === "PING\r\n") Queue.offerUnsafe(incoming, encoder.encode("PONG\r\n"))
        })
      return Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(incoming).pipe(Effect.map((chunk) => [chunk] as const)),
          upgrade: () => Effect.void
        }),
        writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) })
      })
    })
  return {
    factory,
    incoming,
    commands,
    version: (version: string) => {
      greeting = { ...info, version }
    },
    tls: () => {
      greeting = { ...info, tls_available: true, nonce: "challenge" }
    }
  }
})
const frame = (data: Uint8Array) => {
  const command = encoder.encode(`MSG binary 1 ${data.length}\r\n`)
  const bytes = new Uint8Array(command.length + data.length + 2)
  bytes.set(command)
  bytes.set(data, command.length)
  bytes.set([13, 10], bytes.length - 2)
  return bytes
}

describe("native laws replacing upstream internal representations", () => {
  it.effect("platform IP classification preserves IPv4 and IPv6 boundary laws", () =>
    Effect.sync(() => {
      for (const value of ["127.0.0.1", "192.168.1.1", "0.0.0.0", "255.255.255.255", "10.0.0.255"]) {
        expect(isIP(value)).toBe(4)
      }
      for (const value of ["2001:4860:0:2001::68", "::1", "::", "fe80::1A2b:3C4d", "::ffff:127.1.2.3"]) {
        expect(
          isIP(value)
        ).toBe(6)
      }
      for (
        const value of [
          "",
          "invalid",
          "256.0.0.1",
          "127.0.0",
          "127.0",
          "127",
          "1.2..4",
          "127.a.0.1",
          "-0.0.0.0",
          "0.-1.0.0",
          "0.0.-2.0",
          "0.0.0.-3",
          "10000::1",
          "gggg::1",
          "::1:extra",
          "::1::2",
          "::1:",
          "1:2:3:4:5:6:7:8:9",
          "a1:a2:a3:a4::b1:b2:b3:b4"
        ]
      ) expect(isIP(value)).toBe(0)
    }))
  it.effect("WebSocket endpoint parsing accepts case-insensitive protocols and normalized IP forms", () =>
    Effect.sync(() => {
      for (const protocol of ["WS", "ws", "WSS", "wss"]) {
        expect(normalizeServer(`${protocol}://127.0.0.1:4222`)).toMatch(/^wss?:\/\//)
      }
      const expected = "ws://[2001:4860:0:2001:0:0:0:68]:80/"
      expect(normalizeServer("ws://[2001:4860:0:2001::68]")).toBe(expected)
      expect(normalizeServer("ws://[2001:4860:0000:2001:0000:0000:0000:0068]")).toBe(expected)
      expect(normalizeServer("ws://[::]")).toBe("ws://[0:0:0:0:0:0:0:0]:80/")
      expect(normalizeServer("ws://[::1]")).toBe("ws://[0:0:0:0:0:0:0:1]:80/")
      expect(normalizeServer("ws://127.001.002.003")).toBe("ws://127.1.2.3:80/")
      for (const value of ["fe80::1%lo0", "fe80::1%911", "10000::1", "gggg::1", "::1::2", "a1:a2:a3:a4::b1:b2:b3:b4"]) {
        expect(() => normalizeServer(`ws://[${value}]`)).toThrow()
      }
    }))
  it.effect("native reconnect delay callbacks preserve capped user-defined backoff sequences", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const times: Array<number> = []
      let dials = 0
      let delays = 0
      const connection = yield* NATSConnection.make((_server, metadata) =>
        Effect.gen(function*() {
          times.push(yield* Clock.currentTimeMillis)
          if (++dials > 1) {
            return yield* new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("unavailable") })
            })
          }
          return yield* peer.factory(_server, metadata)
        }), {
        servers: "seed:4222",
        maxReconnectAttempts: 4,
        reconnectDelayHandler: () => [0, 100, 200][Math.min(delays++, 2)] ?? 200
      })
      yield* Queue.fail(
        peer.incoming,
        new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: new Error("closed") }) })
      )
      yield* TestClock.adjust(500)
      expect(times.map((time) => time - (times[0] ?? 0))).toEqual([0, 0, 100, 300, 500])
      expect(Option.isSome(yield* connection.closed)).toBe(true)
    }).pipe(Effect.scoped))
  it.live.each([
    { label: "invalid2octet", data: [0xc3, 0x28] },
    { label: "invalidSequenceIdentifier", data: [0xa0, 0xa1] },
    { label: "invalid3octet", data: [0xe2, 0x28, 0xa1] },
    { label: "invalid4octet", data: [0xf0, 0x90, 0x28, 0xbc] },
    { label: "embeddednull", data: [0, 0xf0, 0, 0x28, 0, 0, 0xf0, 0x9f, 0x92, 0xa9, 0] }
  ])("preserves upstream binary payload $label through a real broker", ({ data }) =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      const connection = yield* Node.make({ servers: server.url })
      const sub = yield* connection.subscribe("binary.invalid", { max: 1 })
      const payload = Uint8Array.from(data)
      yield* connection.publish("binary.invalid", payload)
      expect(Option.getOrThrow(yield* sub.stream.pipe(Stream.runHead)).data).toEqual(payload)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live.each(["json", "string", "binary"] as const)(
    "preserves the upstream %s message type through a real broker",
    (kind) =>
      Effect.gen(function*() {
        const server = yield* makeServer()
        const connection = yield* Node.make({ servers: server.url })
        const sub = yield* connection.subscribe("binary.types", { max: 1 })
        yield* connection.publish(
          "binary.types",
          kind === "json" ? "6691" : kind === "string" ? "hello world" : encoder.encode("hello world")
        )
        const message = Option.getOrThrow(yield* sub.stream.pipe(Stream.runHead))
        if (kind === "json") {
          expect(yield* message.json<number>()).toBe(6691)
          expect(yield* message.decode(Schema.Number)).toBe(6691)
        } else {
          expect(yield* message.string).toBe("hello world")
          expect(message.data).toBeInstanceOf(Uint8Array)
          expect(message.data).toEqual(encoder.encode("hello world"))
        }
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.effect.each([0, 1, 26, 100, 1000, 10_000, 65_536, 100_000])(
    "incremental parser grows and compacts without losing %s payload bytes",
    (size) =>
      Effect.sync(() => {
        const data = Uint8Array.from({ length: size }, (_, index) => 97 + index % 26)
        const bytes = frame(data)
        for (const chunkSize of [1, 5, 72, 1024, 16_384]) {
          const parser = new Parser({ maxPayload: 100_000 })
          const frames = []
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            frames.push(...parser.feed(bytes.subarray(offset, offset + chunkSize)))
          }
          expect(frames).toEqual([{ _tag: "Message", subject: "binary", sid: 1, data, wireBytes: size }])
          expect(parser.feed(new Uint8Array())).toEqual([])
          expect(parser.feed(encoder.encode("PING\r\n"))).toEqual([{ _tag: "Ping" }])
        }
      })
  )
  it.effect("bounded parser accepts the exact payload budget and rejects budget plus one before payload arrival", () =>
    Effect.sync(() => {
      for (const limit of [1, 1024, 16_384, 65_536]) {
        expect(new Parser({ maxPayload: limit }).feed(frame(new Uint8Array(limit)))).toHaveLength(1)
        expect(() => new Parser({ maxPayload: limit }).feed(encoder.encode(`MSG binary 1 ${limit + 1}\r\n`))).toThrow(
          /bounds/
        )
        expect(() => new Parser({ maxPayload: limit }).feed(encoder.encode(`MSG binary 1 ${Number.MAX_VALUE}\r\n`)))
          .toThrow()
      }
    }))
  it.effect("returned payloads have exact independent backing buffers across growth and compaction", () =>
    Effect.sync(() => {
      const data = new Uint8Array(65_536).fill(97)
      const input = frame(data)
      const parser = new Parser()
      const first = parser.feed(input)[0]
      if (first?._tag !== "Message") throw new Error("Expected message")
      expect(first.data.buffer.byteLength).toBe(first.data.byteLength)
      expect(first.data.buffer).not.toBe(input.buffer)
      input.fill(0)
      const next = parser.feed(frame(new Uint8Array(100_000).fill(98)))[0]
      if (next?._tag !== "Message") throw new Error("Expected message")
      expect(first.data).toEqual(data)
      expect(next.data.buffer).not.toBe(first.data.buffer)
      next.data.fill(0)
      expect(first.data[0]).toBe(97)
    }))
  it.effect("empty input and command encoding preserve standard byte and string identity laws", () =>
    Effect.sync(() => {
      expect(new Parser().feed(new Uint8Array())).toEqual([])
      expect(encodeCommand("")).toEqual(new Uint8Array())
      expect(decoder.decode(encodeCommand(["1", "2", "3", "4"].join("")))).toBe("1234")
      expect(encodeCommand("1234")).toEqual(Uint8Array.of(49, 50, 51, 52))
      expect(decoder.decode(new Uint8Array())).toBe("")
      const message = new Parser().feed(frame(encoder.encode("Hello World")))[0]
      expect(message?._tag === "Message" ? decoder.decode(message.data) : "").toBe("Hello World")
    }))
  it.effect("byte fragments retain order across repeated complete and partial messages", () =>
    Effect.sync(() => {
      const parser = new Parser()
      for (
        const payload of [
          Uint8Array.of(1),
          Uint8Array.of(1, 2),
          encoder.encode("zeroonetwo"),
          encoder.encode("MSG a 1 b 6\r\nfoobar")
        ]
      ) {
        const input = frame(payload)
        const messages = Array.from(input).flatMap((byte) => parser.feed(Uint8Array.of(byte)))
        expect(messages[0]?._tag === "Message" ? messages[0].data : undefined).toEqual(payload)
      }
    }))
  it.effect.each(["default", "token", "user", "tls", "multi"] as const)(
    "CONNECT preserves the upstream %s option law",
    (kind) =>
      Effect.gen(function*() {
        const peer = yield* harness
        peer.tls()
        const options: NATSOptions.ConnectionOptions = {
          servers: "seed:4222",
          ...(kind === "token" ? { token: "abc", name: "test", pedantic: true, verbose: true } : {}),
          ...(kind === "user" || kind === "multi" ? { user: "test", pass: "secret" } : {}),
          ...(kind === "multi"
            ? {
              token: "mytoken",
              authenticator: NATSAuth.jwtAuthenticator(
                "jwt",
                encoder.encode("SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4")
              )
            }
            : {}),
          ...(kind === "tls" ? { tls: { ca: "CA", key: "KEY", cert: "CERT" } } : {})
        }
        yield* NATSConnection.make(peer.factory, options)
        const command = Option.getOrThrow(
          Option.fromNullishOr(peer.commands.find((command) => command.startsWith("CONNECT ")))
        )
        const connect = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
          command.slice(8).trim()
        )
        expect(connect.version).toMatch(/^\d+\.\d+\.\d+/)
        expect(connect.lang).toBe("typescript-effect")
        expect(connect.protocol).toBe(1)
        expect(connect.verbose).toBe(kind === "token")
        expect(connect.pedantic).toBe(kind === "token")
        if (kind === "token") expect(connect).toMatchObject({ name: "test", auth_token: "abc" })
        else expect(connect.name).toBeUndefined()
        if (kind === "user" || kind === "multi") expect(connect).toMatchObject({ user: "test", pass: "secret" })
        else {
          expect(connect.user).toBeUndefined()
          expect(connect.pass).toBeUndefined()
        }
        if (kind === "multi") {
          expect(connect).toMatchObject({
            auth_token: "mytoken",
            jwt: "jwt",
            sig: expect.any(String),
            nkey: expect.any(String)
          })
        } else if (kind !== "token") expect(connect.auth_token).toBeUndefined()
        for (const field of ["tls", "key", "cert", "ca", "keyFile", "certFile", "caFile"]) {
          expect(connect[field]).toBeUndefined()
        }
        if (kind === "tls") expect(connect.tls_required).toBe(true)
      }).pipe(Effect.scoped)
  )
  it.effect.each([{}, { port: 9999 }])(
    "the native connection constructor is callable and applies default endpoint policy %j",
    (options) =>
      Effect.gen(function*() {
        expect(typeof NATSConnection.make).toBe("function")
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory, options)
        expect((yield* connection.getServers)[0].port).toBe("port" in options ? options.port : 4222)
      }).pipe(Effect.scoped)
  )
  it.effect("unknown message IDs and unmatched mux replies are ignored without disturbing live subscriptions", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:4222" })
      const first = yield* connection.subscribe("known", { max: 1 })
      const second = yield* connection.subscribe("other")
      expect(yield* first.getID).toBe(1)
      expect(yield* second.getID).toBe(2)
      const request = yield* connection.request("silent", "", { timeout: 100 }).pipe(Effect.forkChild)
      yield* connection.flush
      const mux = peer.commands.find((command) => command.startsWith("SUB _INBOX."))?.trim().split(" ")
      if (mux === undefined) throw new Error("Missing mux subscription")
      yield* Queue.offer(
        peer.incoming,
        encoder.encode(`MSG unknown 9999 1\r\nx\r\nMSG unmatched ${mux.at(-1)} 1\r\nx\r\nMSG known 1 1\r\ny\r\n`)
      )
      expect(yield* Option.getOrThrow(yield* first.stream.pipe(Stream.runHead)).string).toBe("y")
      yield* Fiber.interrupt(request)
      yield* second.unsubscribe()
      yield* second.unsubscribe()
      expect(yield* second.isClosed).toBe(true)
      yield* connection.flush
      expect(yield* connection.isClosed).toBe(false)
    }).pipe(Effect.scoped))
  it.effect.each(
    [
      ["1.0.0", "1.0.0"],
      ["1.0.1", "1.0.0"],
      ["1.1.0", "1.0.1"],
      ["1.1.1", "1.1.0"],
      ["1.1.1", "1.1.1"],
      ["1.1.100", "1.1.099"],
      ["2.0.0", "1.500.500"]
    ] as const
  )("version gates preserve numeric comparison for %s and %s", ([actual, minimum]) =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.version(actual)
      const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:4222" })
      const parts = minimum.split(".").map(Number)
      yield* JetStreamApi.make(connection).requireVersion("law", [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0])
    }).pipe(Effect.scoped))
  it.effect.each(["", " ", "a.1.2", "1.a.2", "1.2.a", "v1.2.3", "1.2.3-this-is-a-tag"] as const)(
    "version gate validates upstream semver form %s",
    (version) =>
      Effect.gen(function*() {
        const peer = yield* harness
        peer.version(version)
        const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:4222" })
        const result = yield* JetStreamApi.make(connection).requireVersion("law", [1, 2, 3]).pipe(Effect.result)
        expect(result._tag).toBe(version.startsWith("v") || version.startsWith("1.2.3") ? "Success" : "Failure")
      }).pipe(Effect.scoped)
  )
  it.effect("version feature gates track server updates and reject unsupported requirements", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.version("4.0.0")
      const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:4222" })
      const api = JetStreamApi.make(connection)
      yield* api.requireVersion("feature", [4, 0, 0])
      expect((yield* api.requireVersion("future", [5, 0, 0]).pipe(Effect.result))._tag).toBe("Failure")
      for (const [version, success] of [["2.8.3", true], ["2.8.2", false]] as const) {
        yield* Queue.offer(peer.incoming, encoder.encode("INFO " + JSON.stringify({ version }) + "\r\n"))
        yield* connection.flush
        expect((yield* api.requireVersion("max bytes", [2, 8, 3]).pipe(Effect.result))._tag).toBe(
          success ? "Success" : "Failure"
        )
      }
    }).pipe(Effect.scoped))
  it.effect("Effect semaphore serializes competing work and releases the waiting permit", () =>
    Effect.gen(function*() {
      const semaphore = yield* Semaphore.make(1)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order: Array<string> = []
      const first = yield* semaphore.withPermit(Effect.gen(function*() {
        order.push("first")
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      })).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const second = yield* semaphore.withPermit(Effect.sync(() => {
        order.push("second")
      })).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(order).toEqual(["first"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(order).toEqual(["first", "second"])
    }))
  it.effect("Effect timeout and Deferred preserve typed deadline and rejection laws", () =>
    Effect.gen(function*() {
      const deferred = yield* Deferred.make<void, string>()
      const deadline = yield* Deferred.await(deferred).pipe(Effect.timeout(100), Effect.result, Effect.forkChild)
      yield* TestClock.adjust(100)
      expect((yield* Fiber.join(deadline))._tag).toBe("Failure")
      yield* Deferred.fail(deferred, "hello world")
      expect(yield* Deferred.await(deferred).pipe(Effect.flip)).toBe("hello world")
      expect(Duration.toNanosUnsafe(Duration.millis(1000))).toBe(1_000_000_000n)
      expect(Duration.toMillis(Duration.nanos(1_000_000_000n))).toBe(1000)
    }))
  it.effect("native inbox randomness produces unique single-token reply identifiers", () =>
    Effect.gen(function*() {
      const seen = new Set<string>()
      for (let index = 0; index < 10_000; index++) {
        const inbox = yield* NATSInbox.createInbox()
        expect(inbox).toMatch(/^_INBOX\.[0-9a-f]{32}$/)
        seen.add(inbox)
      }
      expect(seen.size).toBeGreaterThan(9990)
    }))
  it.effect("publish framing uses byte lengths and message string decoding remains standard UTF-8", () =>
    Effect.gen(function*() {
      expect(decoder.decode(encodePublish("x", encoder.encode("你好")))).toBe("PUB x 6\r\n你好\r\n")
      expect(
        yield* NATSMessage.make({ subject: "x", sid: 1, data: encoder.encode("hello world") }, () => Effect.void).string
      ).toBe("hello world")
    }))
})
