import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { encodeCommand, encodePublish, Parser } from "../src/internal/protocol.ts"
import * as NATSHeaders from "../src/NATSHeaders.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
describe("native NATS protocol", () => {
  it.effect("rejects non-finite and invalid numeric INFO fields before dispatch", () =>
    Effect.sync(() => {
      for (
        const json of [
          "{\"max_payload\":1e999}",
          "{\"max_payload\":0}",
          "{\"max_payload\":1.5}",
          "{\"port\":0}",
          "{\"port\":65536}",
          "{\"proto\":-1}",
          "{\"client_id\":-1}",
          "{\"api_lvl\":1e999}"
        ]
      ) {
        expect(() => new Parser().feed(encoder.encode(`INFO ${json}\r\n`))).toThrow()
      }
      expect(new Parser().feed(encoder.encode("INFO {\"port\":65535,\"proto\":0,\"client_id\":0,\"api_lvl\":0}\r\n")))
        .toEqual([{ _tag: "Info", info: { port: 65535, proto: 0, client_id: 0, api_lvl: 0 } }])
    }))
  it.effect("matches the official v3.4 wire oracle for both boolean trace-only values", () =>
    Effect.sync(() => {
      // Source oracle: nats.js v3.4.0 core/src/nats.ts publish adds this
      // header for typeof traceOnly === "boolean", regardless of its value.
      const officialWire = "HPUB subject 35 35\r\nNATS/1.0\r\nNats-Trace-Only: true\r\n\r\n\r\n"
      for (const traceOnly of [false, true]) {
        expect(decoder.decode(encodePublish("subject", new Uint8Array(), { traceOnly }))).toBe(officialWire)
      }
    }))
  it.effect("parses binary messages at every split boundary", () =>
    Effect.sync(() => {
      const data = Uint8Array.from([0, 255, 13, 10, 80, 73, 78, 71])
      const prefix = encodeCommand(`MSG binary 17 reply ${data.length}\r\n`)
      const bytes = new Uint8Array(prefix.length + data.length + 8)
      bytes.set(prefix)
      bytes.set(data, prefix.length)
      bytes.set(encodeCommand("\r\nPING\r\n"), prefix.length + data.length)
      for (let split = 0; split <= bytes.length; split++) {
        const parser = new Parser()
        const frames = [...parser.feed(bytes.subarray(0, split)), ...parser.feed(bytes.subarray(split))]
        expect(frames).toEqual([
          { _tag: "Message", subject: "binary", sid: 17, reply: "reply", data, wireBytes: data.length },
          { _tag: "Ping" }
        ])
      }
      const parser = new Parser()
      expect(Array.from(bytes).flatMap((byte) => parser.feed(Uint8Array.of(byte)))).toHaveLength(2)
    }))
  it.effect("encodes and parses multi-value headers and status", () =>
    Effect.sync(() => {
      const headers = NATSHeaders.headers(503, "No Responders")
      headers.append("X-Value", "one")
      headers.append("X-Value", "two")
      const payload = encoder.encode("hello\r\nworld")
      const wire = encodePublish("subject", payload, { headers, reply: "reply" })
      const hmsg = encoder.encode(decoder.decode(wire).replace(/^HPUB subject reply /, "HMSG subject 1 reply "))
      for (let split = 0; split <= hmsg.length; split++) {
        const parser = new Parser()
        const frames = [...parser.feed(hmsg.subarray(0, split)), ...parser.feed(hmsg.subarray(split))]
        const frame = frames[0]
        expect(frame?._tag).toBe("Message")
        if (frame?._tag === "Message") {
          expect(frame.headers?.values("X-Value")).toEqual(["one", "two"])
          expect(frame.headers?.code).toBe(503)
          expect(frame.data).toEqual(payload)
          expect(frame.wireBytes).toBe(headers.encode().length + payload.length)
        }
      }
    }))
  it.effect("rejects malformed frames and bounded lengths", () =>
    Effect.sync(() => {
      for (
        const input of [
          "MSG a -1 0\r\n",
          "MSG a 1 NaN\r\n",
          "MSG a 1 9007199254740993\r\n",
          "HMSG a 1 20 10\r\n",
          "MSG a 1 2\r\nxx!!",
          "BOGUS\r\n"
        ]
      ) expect(() => new Parser().feed(encoder.encode(input))).toThrow()
      expect(() => new Parser({ maxPayload: 1 }).feed(encoder.encode("MSG a 1 2\r\n"))).toThrow()
      expect(() => new Parser({ maxControlLine: 4 }).feed(encoder.encode("12345"))).toThrow()
      expect(() => encodePublish("has space", new Uint8Array())).toThrow()
      expect(() => encodePublish("subject", new Uint8Array(), { reply: "inject\r\nPING" })).toThrow()
    }))
  it.effect("keeps explicit empty headers and trace options from mutating callers", () =>
    Effect.sync(() => {
      const headers = NATSHeaders.headers()
      expect(decoder.decode(encodePublish("subject", new Uint8Array(), { headers }))).toBe("HPUB subject 0 0\r\n\r\n")
      encodePublish("subject", new Uint8Array(), { headers, traceOnly: true })
      expect(headers.keys()).toEqual([])
      expect(new Parser().feed(encoder.encode("hmsg subject 1 0 0\r\n\r\nping\r\n"))).toEqual([
        { _tag: "Message", subject: "subject", sid: 1, data: new Uint8Array(), wireBytes: 0 },
        { _tag: "Ping" }
      ])
    }))
  it.effect("parses each control frame byte by byte and accepts INFO whitespace", () =>
    Effect.sync(() => {
      for (
        const [wire, expected] of [
          ["PING \r\n", { _tag: "Ping" }],
          ["PONG\r\n", { _tag: "Pong" }],
          ["+OK\r\n", { _tag: "Ok" }],
          ["-ERR 'Authorization Violation'\r\n", { _tag: "Error", message: "Authorization Violation" }],
          ["INFO  {}  \r\n", { _tag: "Info", info: {} }]
        ] as const
      ) {
        const parser = new Parser()
        const result = Array.from(encoder.encode(wire)).flatMap((byte) => parser.feed(Uint8Array.of(byte)))
        expect(result).toEqual([expected])
      }
      for (const wire of [" PING", "POO", "Px", "PIx", "PINx", "PONx", "ZOO", "MSGx", "+x", "-ERRx", "INFOx"]) {
        expect(() => new Parser().feed(encoder.encode(wire))).toThrow()
      }
    }))
  it.effect("keeps delivered payloads stable across subsequent parsing and caller mutation", () =>
    Effect.sync(() => {
      const parser = new Parser()
      const input = encoder.encode("MSG a 1 3\r\none\r\nMSG a 1 3\r\ntwo\r\n")
      const frames = parser.feed(input)
      input.fill(0)
      parser.feed(encoder.encode("MSG a 1 5\r\nthree\r\n"))
      expect(frames.map((frame) => frame._tag === "Message" ? decoder.decode(frame.data) : "")).toEqual(["one", "two"])
    }))
  it.effect("parses large payloads with long reply subjects without unbounded control growth", () =>
    Effect.sync(() => {
      const parser = new Parser()
      const reply = "_INBOX." + "A".repeat(128)
      expect(parser.feed(encoder.encode(`MSG subject 2 ${reply} 102400\r\n`))).toEqual([])
      for (let i = 0; i < 100; i++) expect(parser.feed(new Uint8Array(1024))).toEqual([])
      const frames = parser.feed(encoder.encode("\r\n"))
      const frame = frames[0]
      expect(frame?._tag).toBe("Message")
      if (frame?._tag === "Message") {
        expect(frame.data.length).toBe(102400)
        expect(frame.reply).toBe(reply)
      }
    }))
  it.effect("accepts partial INFO updates preserving future fields", () =>
    Effect.sync(() => {
      const frames = new Parser().feed(
        encoder.encode("INFO {\"ldm\":true,\"future_capability\":42}\r\nPONG\r\n+OK\r\n")
      )
      expect(frames).toEqual([
        { _tag: "Info", info: { ldm: true, future_capability: 42 } },
        { _tag: "Pong" },
        { _tag: "Ok" }
      ])
      expect(() => new Parser().feed(encoder.encode("INFO {\"ldm\":\"true\"}\r\n"))).toThrow()
    }))
  it.effect("handles partial UTF-8 INFO and subject fields without decoding incomplete codepoints", () =>
    Effect.sync(() => {
      const infoBytes = encoder.encode("INFO {\"future\":\"🤖\"}\r\nMSG café 1 1\r\nx\r\n")
      for (let split = 0; split <= infoBytes.length; split++) {
        const parser = new Parser()
        const frames = [...parser.feed(infoBytes.subarray(0, split)), ...parser.feed(infoBytes.subarray(split))]
        expect(frames).toEqual([
          { _tag: "Info", info: { future: "🤖" } },
          { _tag: "Message", subject: "café", sid: 1, data: encoder.encode("x"), wireBytes: 1 }
        ])
      }
    }))
  it.effect("preserves header matching modes and rejects injection", () =>
    Effect.sync(() => {
      const headers = NATSHeaders.headers()
      headers.append("x-value", " one ")
      headers.append("X-Value", "two")
      expect(headers.values("X-VALUE", NATSHeaders.Match.IgnoreCase)).toEqual(["one", "two"])
      expect(headers.get("x-value", NATSHeaders.Match.CanonicalMIME)).toBe("two")
      headers.set("X-VALUE", "three", NATSHeaders.Match.IgnoreCase)
      expect(headers.keys()).toEqual(["X-VALUE"])
      expect(headers.last("X-VALUE")).toBe("three")
      expect(() => headers.set("bad:name", "value")).toThrow()
      expect(() => headers.set("name", "value\r\nattack")).toThrow()
      const copy = NATSHeaders.MsgHdrsImpl.decode(headers.encode())
      expect(headers.equals(copy)).toBe(true)
    }))
})
