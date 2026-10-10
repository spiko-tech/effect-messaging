import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { createConnection } from "node:net"
import { Parser } from "../src/internal/protocol.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { canonicalMIMEHeaderKey, headers, Match, MsgHdrsImpl } from "../src/NATSHeaders.ts"
import { testConnection } from "./dependencies.ts"

const decode = (value: string) => MsgHdrsImpl.decode(new TextEncoder().encode(value))
const publishRaw = (commands: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "localhost", port: 4222 })
        let state = "info"
        let pending = ""
        let finished = false
        const cleanup = () => {
          signal.removeEventListener("abort", abort)
          socket.removeAllListeners()
          socket.destroy()
        }
        const complete = (error?: Error) => {
          if (finished) return
          finished = true
          cleanup()
          if (error === undefined) resolve()
          else reject(error)
        }
        const abort = () => complete(new Error("Raw header interoperability interrupted"))
        signal.addEventListener("abort", abort, { once: true })
        socket.on("error", (error) => complete(error))
        socket.on("close", () => complete(new Error("Raw header peer closed before flush")))
        socket.on("data", (data: Buffer) => {
          pending += data.toString()
          if (pending.includes("-ERR")) return complete(new Error(pending))
          if (state === "info" && pending.includes("\r\n")) {
            pending = ""
            state = "connect"
            socket.write("CONNECT {\"headers\":true,\"protocol\":1}\r\nPING\r\n")
          } else if (state === "connect" && pending.includes("PONG\r\n")) {
            pending = ""
            state = "publish"
            socket.write(`${commands}PING\r\n`)
          } else if (state === "publish" && pending.includes("PONG\r\n")) complete()
        })
      }),
    catch: (cause) => new Error("Raw header interoperability peer failed", { cause })
  })

describe("NATS headers 3.4.0 behavioral contracts", () => {
  it.effect.each(["bad:", "bad ", "bad\t", "bad\r", "bad\n", String.fromCharCode(127)])(
    "rejects invalid header name %j",
    (key) =>
      Effect.sync(() => {
        expect(() => headers().set(key, "value")).toThrow()
      })
  )
  it.effect.each(["\r", "\n", "safe\r\nInjected: bad"])("rejects header injection %j", (value) =>
    Effect.sync(() => {
      expect(() => headers().set("Safe", value)).toThrow()
    }))

  it.effect("validates every ASCII name character and exported records cannot mutate stored values", () =>
    Effect.sync(() => {
      for (let code = 0; code < 128; code++) {
        const key = `a${String.fromCharCode(code)}b`
        if (code < 33 || code > 126 || code === 58) expect(() => headers().set(key, "value")).toThrow()
        else expect(() => headers().set(key, "value")).not.toThrow()
      }
      expect(() => headers().set("élan", "value")).toThrow()
      const value = MsgHdrsImpl.fromRecord({ A: ["one", "two"] })
      const record = value.toRecord()
      record.A?.push("external mutation")
      expect(value.values("A")).toEqual(["one", "two"])
    }))

  it.effect("exact matching distinguishes differently cased names", () =>
    Effect.sync(() => {
      const value = headers()
      value.set("a", "first")
      value.set("A", "second")
      value.append("a", "third")
      expect(value.values("a")).toEqual(["first", "third"])
      expect(value.values("A")).toEqual(["second"])
      value.delete("a")
      expect(value.has("a")).toBe(false)
      expect(value.has("A")).toBe(true)
      value.set("A", "replacement")
      expect(value.values("A")).toEqual(["replacement"])
      expect(value.size()).toBe(1)
    }))

  it.effect("ignore-case set replaces all matching variants and delete removes every variant", () =>
    Effect.sync(() => {
      const value = headers()
      value.set("a", "first", Match.IgnoreCase)
      value.set("A", "second", Match.IgnoreCase)
      expect(value.size()).toBe(1)
      expect(value.has("a", Match.IgnoreCase)).toBe(true)
      expect(value.has("A", Match.IgnoreCase)).toBe(true)
      expect(value.values("a", Match.IgnoreCase)).toEqual(["second"])
      expect(value.values("A", Match.IgnoreCase)).toEqual(["second"])
      value.append("a", "third")
      expect(value.values("a", Match.IgnoreCase).sort()).toEqual(["second", "third"])
      value.delete("A", Match.IgnoreCase)
      expect(value.size()).toBe(0)
    }))

  it.effect("canonical MIME matching normalizes keys without replacing exact lowercase entries", () =>
    Effect.sync(() => {
      const value = headers()
      value.set("ab", "lowercase")
      value.append("aB", "canonical", Match.CanonicalMIME)
      expect(value.size()).toBe(2)
      expect(value.get("Ab")).toBe("canonical")
      expect(value.get("ab")).toBe("lowercase")
      value.set("aB", "replacement", Match.CanonicalMIME)
      expect(value.get("Ab")).toBe("replacement")
      value.delete("ab", Match.CanonicalMIME)
      expect(value.get("ab")).toBe("lowercase")
    }))
  it.effect("canonical MIME set append and delete share the same normalized key", () =>
    Effect.sync(() => {
      const value = headers()
      value.set("ab", "ab", Match.CanonicalMIME)
      expect(value.has("ab")).toBe(false)
      expect(value.has("Ab")).toBe(true)
      value.set("aB", "A", Match.CanonicalMIME)
      value.append("ab", "aa", Match.CanonicalMIME)
      expect(value.size()).toBe(1)
      expect(value.values("ab", Match.CanonicalMIME).sort()).toEqual(["A", "aa"])
      value.delete("ab", Match.CanonicalMIME)
      expect(value.size()).toBe(0)
    }))

  it.effect.each(
    [
      [Match.Exact, ["first"], ["second"], 2],
      [Match.IgnoreCase, ["first", "second"], [], 1],
      [Match.CanonicalMIME, ["first"], ["second"], 2]
    ] as const
  )("append matching law %s", ([match, lower, upper, size]) =>
    Effect.sync(() => {
      const value = headers()
      value.set("a", "first")
      value.append("A", "second", match)
      expect(value.size()).toBe(size)
      expect(value.values("a")).toEqual(lower)
      expect(value.values("A")).toEqual(upper)
    }))

  it.effect.each(["foo", "foo-bar", "foo-bar-baz"])("canonicalizes %s", (key) =>
    Effect.sync(() => {
      expect(canonicalMIMEHeaderKey(key)).toBe(
        key.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("-")
      )
    }))

  it.effect.each(
    [
      [0, ""],
      [100, "Idle Heartbeat"],
      [200, ""],
      [200, "OK"],
      [404, "No Messages"],
      [503, "No Responders"]
    ] as const
  )("decodes status %s %s", ([code, description]) =>
    Effect.sync(() => {
      const value = decode(`NATS/1.0${code ? ` ${code} ${description}`.trimEnd() : ""}\r\n\r\n`)
      expect(value.code).toBe(code)
      expect(value.description).toBe(description)
      expect(value.hasError).toBe(code >= 300)
      expect(value.status).toBe(`${code} ${description}`.trim())
    }))

  it.effect("equality compares all fields and values independently of insertion order", () =>
    Effect.sync(() => {
      const first = headers()
      const second = headers()
      expect(first.equals(second)).toBe(true)
      first.set("a", "one")
      first.append("a", "two")
      second.set("a", "two")
      second.append("a", "one")
      expect(first.equals(second)).toBe(true)
      second.append("a", "three")
      expect(first.equals(second)).toBe(false)
      first.append("a", "different")
      expect(first.equals(second)).toBe(false)
      expect(first.equals(headers())).toBe(false)
    }))

  it.effect("malformed field lines are ignored while valid values trim whitespace", () =>
    Effect.sync(() => {
      const value = decode("NATS/1.0\r\nBAD\r\nA:A\r\nB:   B   \r\n\r\n")
      expect(value.size()).toBe(2)
      expect(value.get("A")).toBe("A")
      expect(value.get("B")).toBe("B")
    }))

  it.effect("status header blocks retain ordinary entries", () =>
    Effect.sync(() => {
      const value = decode("NATS/1.0 100 Idle Heartbeat\r\nNats-Last-Consumer: 1\r\nNats-Last-Stream: 2\r\n\r\n")
      expect(value.code).toBe(100)
      expect(value.get("Nats-Last-Consumer")).toBe("1")
      expect(value.get("Nats-Last-Stream")).toBe("2")
    }))
  it.effect("HMSG exposes ignored malformed lines, trimmed values and status entries", () =>
    Effect.sync(() => {
      for (
        const [block, expected] of [
          ["NATS/1.0\r\nBAD\r\n\r\n", {}],
          ["NATS/1.0\r\nA:A\r\n\r\n", { A: ["A"] }],
          ["NATS/1.0\r\nA:   A   \r\n\r\n", { A: ["A"] }],
          ["NATS/1.0 100 Idle Heartbeat\r\nNats-Last-Consumer: 1\r\nNats-Last-Stream: 1\r\n\r\n", {
            "Nats-Last-Consumer": ["1"],
            "Nats-Last-Stream": ["1"]
          }]
        ] as const
      ) {
        const size = new TextEncoder().encode(block).length
        const frames = new Parser().feed(
          new TextEncoder().encode(`HMSG subject 1 reply ${size} ${size}\r\n${block}\r\n`)
        )
        expect(frames).toHaveLength(1)
        if (frames[0]._tag !== "Message") throw new Error("Expected HMSG message")
        expect(Object.fromEntries(frames[0].headers ?? [])).toEqual(expected)
        expect(frames[0].data).toHaveLength(0)
      }
    }))

  it.effect("constructing status headers requires both code and description", () =>
    Effect.sync(() => {
      expect(() => headers(500)).toThrow()
      expect(() => headers(0, "description")).toThrow()
    }))

  it.effect("iteration, last and record conversion preserve repeated values", () =>
    Effect.sync(() => {
      const value = headers()
      value.set("a", "one")
      value.append("b", "two")
      value.append("b", "three")
      expect(Array.from(value)).toEqual([["a", ["one"]], ["b", ["two", "three"]]])
      expect(value.last("b")).toBe("three")
      expect(value.last("a")).toBe("one")
      expect(value.last("missing")).toBe("")
      expect(value.toRecord()).toEqual({ a: ["one"], b: ["two", "three"] })
      expect(MsgHdrsImpl.fromRecord(value.toRecord()).equals(value)).toBe(true)
      expect(MsgHdrsImpl.fromRecord({ a: "one", b: ["two", "three"] }).equals(value)).toBe(true)
    }))
  it.effect("record normalization stringifies scalar numbers and preserves string arrays", () =>
    Effect.sync(() => {
      const value = MsgHdrsImpl.fromRecord({ a: "x", d: 1 })
      expect(value.get("a")).toBe("x")
      expect(value.get("d")).toBe("1")
      expect(value.toRecord()).toEqual({ a: ["x"], d: ["1"] })
    }))

  it.effect("empty headers have no encoded payload", () =>
    Effect.sync(() => {
      const value = headers()
      expect(value.toString()).toBe("")
      expect(value.encode()).toHaveLength(0)
      expect(MsgHdrsImpl.decode(value.encode()).size()).toBe(0)
    }))

  it.live("request headers and custom response status survive a broker round trip", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const requestHeaders = headers()
      requestHeaders.set("x", "request")
      const subscription = yield* connection.subscribe("native.headers.request", { max: 1 })
      yield* subscription.stream.pipe(
        Stream.runForEach((message) => {
          expect(Option.getOrThrow(message.headers).get("x")).toBe("request")
          const replyHeaders = headers(500, "custom status")
          replyHeaders.set("x", Option.getOrThrow(message.headers).get("x"))
          return message.respond("", { headers: replyHeaders })
        }),
        Effect.forkChild
      )
      const response = yield* connection.request("native.headers.request", "", { headers: requestHeaders })
      expect(Option.getOrThrow(response.headers).code).toBe(500)
      expect(Option.getOrThrow(response.headers).description).toBe("custom status")
      expect(Option.getOrThrow(response.headers).get("x")).toBe("request")
    }).pipe(Effect.provide(testConnection)))
  it.live("published headers retain both exact keys through a broker round trip", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sent = headers()
      sent.set("a", "aa")
      sent.set("b", "bb")
      const sub = yield* connection.subscribe("native.headers.publish", { max: 1 })
      yield* connection.publish("native.headers.publish", "", { headers: sent })
      const received = yield* Stream.runCollect(sub.stream)
      expect(received).toHaveLength(1)
      const value = Option.getOrThrow(received[0].headers)
      expect(value.keys()).toHaveLength(2)
      expect(value.has("a")).toBe(true)
      expect(value.has("b")).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("broker-normalized HPUB edge cases decode payload and status without NaN", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe("native.headers.raw", { max: 4 })
      yield* connection.flush
      yield* publishRaw([
        "HPUB native.headers.raw  13 15\nNATS/1.0 \r\n\r\nhi\r\n",
        "HPUB native.headers.raw  17 19\nNATS/1.0  1 H\r\n\r\nhi\r\n",
        "HPUB native.headers.raw 0 0\r\n\r\n",
        "HPUB native.headers.raw 12 12\r\nNATS/1.0\r\n\r\n\r\n"
      ].join(""))
      const messages = yield* Stream.runCollect(subscription.stream)
      expect(yield* Effect.forEach(messages, (message) => message.string)).toEqual(["hi", "hi", "", ""])
      expect(Option.getOrThrow(messages[0].headers).code).toBe(0)
      expect(Option.getOrThrow(messages[1].headers).code).toBe(1)
      expect(Option.getOrThrow(messages[1].headers).description).toBe("H")
      expect(messages[2].headers).toEqual(Option.none())
      expect(Option.getOrThrow(messages[3].headers).code).toBe(0)
    }).pipe(Effect.provide(testConnection)))
})
