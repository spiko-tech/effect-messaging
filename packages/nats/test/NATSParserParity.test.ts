import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type * as Protocol from "../src/internal/protocol.ts"
import { Parser } from "../src/internal/protocol.ts"
import { headers } from "../src/NATSHeaders.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const byByte = (wire: string) => {
  const parser = new Parser()
  return Array.from(encoder.encode(wire)).flatMap((byte) => parser.feed(Uint8Array.of(byte)))
}
const parse = (wire: string) => new Parser().feed(encoder.encode(wire))
const messages = (frames: Array<Protocol.Frame>) => frames.filter((frame) => frame._tag === "Message")

describe("Every upstream v3.4.0 parser case through native frame laws", () => {
  it.effect("parser - ping", () =>
    Effect.sync(() => {
      expect(byByte("PING\r\n")).toEqual([{ _tag: "Ping" }])
      const parser = new Parser()
      expect(parser.feed(encoder.encode("PING \r"))).toEqual([])
      expect(parser.feed(encoder.encode(" \n"))).toEqual([{ _tag: "Ping" }])
      expect(parser.feed(encoder.encode("PING \r \n"))).toEqual([{ _tag: "Ping" }])
    }))

  it.effect("parser - err", () =>
    Effect.sync(() => {
      expect(byByte("-ERR '234 6789'\r\n")).toEqual([{ _tag: "Error", message: "234 6789" }])
      expect(parse("-ERR 'Any error'\r\n")).toEqual([{ _tag: "Error", message: "Any error" }])
    }))

  it.effect("parser - ok", () =>
    Effect.sync(() => {
      expect(byByte("+OK\r\n")).toEqual([{ _tag: "Ok" }])
      expect(byByte("+OKay\r\n")).toEqual([{ _tag: "Ok" }])
    }))

  it.effect("parser - info", () =>
    Effect.sync(() => {
      expect(byByte("INFO {}\r\n")).toEqual([{ _tag: "Info", info: {} }])
    }))

  it.effect("parser - errors", () =>
    Effect.sync(() => {
      for (
        const wire of [
          " PING",
          "POO",
          "Px",
          "PIx",
          "PINx",
          "PONx",
          "ZOO",
          "Mx\r\n",
          "MSx\r\n",
          "MSGx\r\n",
          "MSG foo\r\n",
          "MSG \r\n",
          "MSG foo 1\r\n",
          "MSG foo bar 1\r\n",
          "MSG foo bar 1 baz\r\n",
          "MSG foo 1 bar baz\r\n",
          "+x\r\n",
          "+0x\r\n",
          "-x\r\n",
          "-Ex\r\n",
          "-ERx\r\n",
          "-ERRx\r\n"
        ]
      ) expect(() => parse(wire)).toThrow()
    }))

  it.effect("parser - split msg", () =>
    Effect.sync(() => {
      for (const invalid of ["MSG a\r\n", "MSG a b c\r\n"]) expect(() => parse(invalid)).toThrow()
      const parser = new Parser()
      const chunks = ["MSG a", " 1 3\r\nf", "oo\r\n", "MSG a 1 3\r\nba", "r\r\n", "MSG a 1 6\r\nfo", "ob", "ar\r\n"]
      const frames = messages(chunks.flatMap((chunk) => parser.feed(encoder.encode(chunk))))
      expect(frames.map((frame) => decoder.decode(frame.data))).toEqual(["foo", "bar", "foobar"])
      expect(frames.every((frame) => frame.subject === "a" && frame.sid === 1)).toBe(true)
      const payload = Uint8Array.from({ length: 100 }, (_, index) => 97 + index % 26)
      expect(parser.feed(encoder.encode("MSG a 1 b 103\r\nfoo"))).toEqual([])
      expect(parser.feed(payload)).toEqual([])
      const frame = messages(parser.feed(encoder.encode("\r\n")))[0]
      expect(frame.reply).toBe("b")
      expect(frame.data.subarray(0, 3)).toEqual(encoder.encode("foo"))
      expect(frame.data.subarray(3)).toEqual(payload)
    }))

  it.effect("parser - info arg", () =>
    Effect.sync(() => {
      const info = {
        server_id: "test",
        host: "localhost",
        port: 4222,
        version: "1.2.3",
        auth_required: true,
        tls_required: true,
        max_payload: 2 * 1024 * 1024,
        connect_urls: ["localhost:5222", "localhost:6222"]
      }
      const wire = encoder.encode(`INFO ${JSON.stringify(info)}\r\n`)
      const parser = new Parser()
      expect(parser.feed(wire.subarray(0, 9))).toEqual([])
      expect(parser.feed(wire.subarray(9, 11))).toEqual([])
      expect(parser.feed(wire.subarray(11))).toEqual([{ _tag: "Info", info }])
      for (
        const input of [
          "INFO {}\r\n",
          "INFO  {}\r\n",
          "INFO {} \r\n",
          "INFO { \"server_id\": \"test\"  }   \r\n",
          "INFO {\"connect_urls\":[]}\r\n"
        ]
      ) expect(parse(input)[0]._tag).toBe("Info")
      for (const invalid of ["IxNFO {}\r\n", "INxFO {}\r\n", "INFxO {}\r\n", "INFOx {}\r\n", "INFO{}\r\n"]) {
        expect(() => parse(invalid)).toThrow()
      }
      // Incomplete bytes remain pending on a fresh parser; a failed parser
      // is discarded with its physical connection rather than reused.
      expect(new Parser().feed(encoder.encode("INFO {}"))).toEqual([])
    }))

  it.effect("parser - header", () =>
    Effect.sync(() => {
      const parser = new Parser()
      const metadata = headers()
      metadata.set("x", "y")
      const bytes = metadata.encode()
      expect(parser.feed(encoder.encode(`HMSG a 1 ${bytes.length} ${bytes.length + 3}\r\n`))).toEqual([])
      expect(parser.feed(bytes)).toEqual([])
      const frame = messages(parser.feed(encoder.encode("bar\r\n")))[0]
      expect(frame.subject).toBe("a")
      expect(frame.sid).toBe(1)
      expect(frame.headers?.get("x")).toBe("y")
      expect(Array.from(frame.headers ?? [])).toEqual(Array.from(metadata))
      expect(decoder.decode(frame.data)).toBe("bar")
    }))

  it.effect("parser - subject", () =>
    Effect.sync(() => {
      const parser = new Parser()
      const reply = "_INBOX.4E66Z7UREYUY9VKDNFBT1A.4E66Z7UREYUY9VKDNFBT72.4E66Z7UREYUY9VKDNFBSVI"
      expect(parser.feed(encoder.encode(`MSG foo 1 ${reply} 102400\r\n`))).toEqual([])
      for (let index = 0; index < 100; index++) expect(parser.feed(new Uint8Array(1024))).toEqual([])
      const frame = messages(parser.feed(encoder.encode("\r\n")))[0]
      expect(frame.data).toEqual(new Uint8Array(102400))
      expect(frame.subject).toBe("foo")
      expect(frame.sid).toBe(1)
      expect(frame.reply).toBe(reply)
    }))

  for (
    const [withHeaders, testName] of [
      [false, "parser - msg buffers don't clobber"],
      [true, "parser - hmsg buffers don't clobber"]
    ] as const
  ) {
    it.effect(testName, () =>
      Effect.sync(() => {
        const parser = new Parser()
        const retained: ReturnType<typeof messages> = []
        const payload = new Uint8Array(1024 * 1024)
        for (let index = 0; index < 100; index++) {
          payload.fill(97 + index % 26)
          const subject = String.fromCharCode(97 + (index + 1) % 26).repeat(26)
          const reply = String.fromCharCode(97 + (index + 2) % 26).repeat(26)
          const key = String.fromCharCode(97 + (index + 3) % 26).repeat(12)
          const metadata = headers()
          metadata.set(key, key)
          const headerBytes = withHeaders ? metadata.encode() : new Uint8Array()
          const prefix = encoder.encode(
            withHeaders ?
              `HMSG ${subject} 1 ${reply} ${headerBytes.length} ${headerBytes.length + payload.length}\r\n` :
              `MSG ${subject} 1 ${reply} ${payload.length}\r\n`
          )
          const wire = new Uint8Array(prefix.length + headerBytes.length + payload.length + 2)
          wire.set(prefix)
          wire.set(headerBytes, prefix.length)
          wire.set(payload, prefix.length + headerBytes.length)
          wire.set([13, 10], wire.length - 2)
          retained.push(...messages(parser.feed(wire)))
          wire.fill(0)
        }
        expect(retained).toHaveLength(100)
        for (const [index, frame] of retained.entries()) {
          expect(frame.subject).toBe(String.fromCharCode(97 + (index + 1) % 26).repeat(26))
          expect(frame.reply).toBe(String.fromCharCode(97 + (index + 2) % 26).repeat(26))
          expect(frame.data.length).toBe(payload.length)
          expect(frame.data.every((byte) => byte === 97 + index % 26)).toBe(true)
          if (withHeaders) {
            const key = String.fromCharCode(97 + (index + 3) % 26).repeat(12)
            expect(frame.headers?.get(key)).toBe(key)
          }
        }
      }))
  }

  it.effect("parser - protoParseInt", () =>
    Effect.sync(() => {
      for (const integer of ["0", "1", "12345678", "999999999999999"]) {
        expect(messages(parse(`MSG a ${integer} 0\r\n\r\n`))[0].sid).toBe(Number(integer))
      }
      for (const integer of ["", "abc", "12a", "-1", "1234567890123456", "9999999999999999"]) {
        expect(() => parse(`MSG a ${integer} 0\r\n\r\n`)).toThrow()
      }
      for (const limit of [100, 1024]) {
        const parser = new Parser({ maxPayload: limit })
        expect(parser.feed(encoder.encode(`MSG a 1 ${limit}\r\n`))).toEqual([])
        expect(() => new Parser({ maxPayload: limit }).feed(encoder.encode(`MSG a 1 ${limit + 1}\r\n`))).toThrow()
      }
    }))

  it.effect("parser - oversized msg size rejects", () =>
    Effect.sync(() => {
      expect(() => parse("MSG foo 1 1234567890123456\r\n")).toThrow()
    }))

  it.effect("parser - describe", () =>
    Effect.sync(() => {
      const frames = parse(
        "MSG a 1 0\r\n\r\n+OK\r\nPING\r\nPONG\r\n-ERR 'error message'\r\nINFO {\"server_id\":\"test\"}\r\n"
      )
      expect(frames.map((frame) => frame._tag)).toEqual(["Message", "Ok", "Ping", "Pong", "Error", "Info"])
      expect(frames[4]).toEqual({ _tag: "Error", message: "error message" })
      expect(frames[5]).toEqual({ _tag: "Info", info: { server_id: "test" } })
    }))
})
