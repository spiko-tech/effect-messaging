import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema, Stream } from "effect"
import * as Api from "../src/internal/jetstreamApi.ts"
import * as Wire from "../src/internal/jetstreamSchemas.ts"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamConsumerAPI from "../src/JetStreamConsumerAPI.ts"
import * as JetStreamDirectStreamAPI from "../src/JetStreamDirectStreamAPI.ts"
import * as JetStreamMessage from "../src/JetStreamMessage.ts"
import * as JetStreamStoredMessage from "../src/JetStreamStoredMessage.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSError from "../src/NATSError.ts"
import * as NATSHeaders from "../src/NATSHeaders.ts"
import * as NATSMessage from "../src/NATSMessage.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"

const encoder = new TextEncoder()
const response = (text: string, reply?: string, headers?: NATSHeaders.MsgHdrs) =>
  NATSMessage.make({
    subject: "orders.created",
    sid: 1,
    data: encoder.encode(text),
    ...(reply === undefined ? {} : { reply }),
    ...(headers === undefined ? {} : { headers })
  }, () => Effect.void)

const fixture = (
  handler: NATSConnection.NATSConnection["request"] = () => Effect.succeed(response("{}")),
  version = "2.15.0"
) => {
  const publications: Array<
    { subject: string; payload: NATSOptions.Payload | undefined; options: NATSOptions.PublishOptions | undefined }
  > = []
  const unavailable = Effect.fail(new NATSError.NATSConnectionError({ reason: "Unexpected fixture operation" }))
  const connection: NATSConnection.NATSConnection = {
    [NATSConnection.TypeId]: NATSConnection.TypeId,
    createInbox: Effect.sync(() => `_INBOX.${crypto.randomUUID().replaceAll("-", "")}`),
    info: Option.some({
      server_id: "fixture",
      server_name: "fixture",
      version,
      go: "fixture",
      host: "localhost",
      port: 4222,
      proto: 1,
      max_payload: 1048576,
      client_id: 1
    }),
    publish: (subject, payload, options) =>
      Effect.sync(() => {
        publications.push({ subject, payload, options })
      }),
    publishMessage: () => unavailable,
    respondMessage: () => unavailable,
    request: handler,
    requestMany: () => unavailable,
    subscribe: () => unavailable,
    flush: Effect.void,
    drain: Effect.void,
    close: Effect.void,
    closed: Effect.succeed(Option.none()),
    isClosed: Effect.succeed(false),
    isDraining: Effect.succeed(false),
    getServer: Effect.succeed("nats://localhost:4222"),
    getServers: Effect.succeed([]),
    setServers: () => Effect.void,
    reconnect: Effect.void,
    status: Effect.succeed(Stream.empty),
    state: Effect.succeed({ state: "Connected", generation: 1, server: "fixture" }),
    changes: Stream.never,
    stats: Effect.succeed({ inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0 }),
    rtt: Effect.succeed(0)
  }
  return { connection, publications, api: Api.make(connection) }
}
const errorOf = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.flip)

describe("JetStream wire contracts", () => {
  for (
    const [body, reason] of [
      ["{", "Invalid JetStream JSON response"],
      ["null", "Invalid JetStream response envelope"],
      ["[]", "Invalid JetStream response envelope"],
      [
        "{\"error\":{\"code\":\"404\",\"err_code\":10059,\"description\":\"missing\"}}",
        "Invalid JetStream response envelope"
      ],
      ["{\"stream\":\"orders\",\"seq\":\"1\"}", "Invalid JetStream response"],
      ["{\"stream\":4,\"seq\":1}", "Invalid JetStream response"]
    ]
  ) {
    it.effect(`rejects untrusted response ${body}`, () =>
      Effect.gen(function*() {
        const error = yield* errorOf(fixture().api.decode(encoder.encode(body), Wire.PubAck))
        expect(error.reason).toBe(reason)
      }))
  }

  it.effect("preserves broker error metadata through public service errors", () =>
    Effect.gen(function*() {
      const metadata = { code: 409, err_code: 10071, description: "wrong last sequence" }
      const { connection } = fixture(() => Effect.succeed(response(JSON.stringify({ error: metadata }))))
      const program = Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        return yield* errorOf(client.publish("orders.created", "payload"))
      })
      const error = yield* program.pipe(
        Effect.provide(JetStreamClient.layer()),
        Effect.provideService(NATSConnection.NATSConnection, connection)
      )
      expect(error._tag).toBe("JetStreamClientError")
      expect(error.apiError).toEqual(metadata)
      expect(error.reason).toBe(metadata.description)
    }))

  for (
    const [version, valid] of [
      ["2.11.0", true],
      ["v2.11.1-beta", true],
      ["3.0.0", true],
      ["2.10.99", false],
      [
        "2.9.0",
        false
      ],
      ["garbage", false],
      ["a.b.c", false]
    ] as const
  ) {
    it.effect(`checks numeric server version ${version}`, () =>
      Effect.gen(function*() {
        const api = fixture(undefined, version).api
        const accepted = yield* api.requireVersion("priority groups", [2, 11, 0]).pipe(
          Effect.match({ onSuccess: () => true, onFailure: () => false })
        )
        expect(accepted).toBe(valid)
      }))
  }

  it.effect("rejects unavailable info without sending an API request", () =>
    Effect.gen(function*() {
      const { connection } = fixture()
      const error = yield* errorOf(Api.make({ ...connection, info: Option.none() }).requireVersion("batch", [2, 14, 0]))
      expect(error.reason).toBe("Connection info is unavailable")
    }))

  it.effect("rejects unsupported reset before wire IO", () =>
    Effect.gen(function*() {
      const error = yield* errorOf(
        JetStreamConsumerAPI.make(fixture(undefined, "2.13.0").api).reset("orders", "worker")
      )
      expect(error.reason).toContain("requires NATS server 2.14.0")
    }))

  it.effect("encodes domain and required API level headers", () =>
    Effect.gen(function*() {
      const requests: Array<string> = []
      const { connection } = fixture((subject, payload, options) =>
        Effect.sync(() => {
          requests.push(subject)
          expect(payload).toBe("{\"enabled\":true}")
          expect(options?.headers?.get("Nats-Required-Api-Level")).toBe("4")
          expect(options?.timeout).toBe(321)
          return response(JSON.stringify({ type: "io.nats.jetstream.api.v1.check", success: true }))
        })
      )
      const api = Api.make(connection, { domain: "east", sendRequiredApiLevel: true, timeout: 321 })
      expect(yield* api.api("CHECK", { enabled: true }, Wire.SuccessResponse, 4)).toEqual({
        type: "io.nats.jetstream.api.v1.check",
        success: true
      })
      expect(requests).toEqual(["$JS.east.API.CHECK"])
    }))

  it.effect("paginates offsets once and stops cursor IO after exhaustion", () =>
    Effect.gen(function*() {
      const offsets: Array<number> = []
      const { api } = fixture((_subject, payload) =>
        Effect.sync(() => {
          const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ offset: Schema.Number })))(
            String(payload)
          )
          offsets.push(decoded.offset)
          return response(
            JSON.stringify({
              total: 3,
              offset: decoded.offset,
              limit: 2,
              names: decoded.offset === 0 ? ["one", "two"] : ["three"]
            })
          )
        })
      )
      const lister = api.list("STREAM.NAMES", {}, "names", Schema.String)
      expect(yield* lister.next()).toEqual(["one", "two"])
      expect(yield* lister.next()).toEqual(["three"])
      expect(yield* lister.next()).toEqual([])
      expect(yield* lister.next()).toEqual([])
      expect(offsets).toEqual([0, 2])
      expect(yield* Stream.runCollect(lister.stream)).toEqual(["one", "two", "three"])
    }))

  it.effect("terminates zero-limit pages and rejects malformed items", () =>
    Effect.gen(function*() {
      const api = fixture(() =>
        Effect.succeed(response("{\"total\":20,\"offset\":0,\"limit\":0,\"names\":[\"one\"]}"))
      ).api
      expect(yield* Stream.runCollect(api.list("STREAM.NAMES", {}, "names", Schema.String).stream)).toEqual(["one"])
      const malformed =
        fixture(() => Effect.succeed(response("{\"total\":1,\"offset\":0,\"limit\":1,\"names\":[false]}"))).api
      expect((yield* errorOf(malformed.list("STREAM.NAMES", {}, "names", Schema.String).next())).reason).toBe(
        "Invalid JetStream page"
      )
    }))

  for (const name of ["", "with space", "a.b", "a*", "a>", "a/b", "a\\b"]) {
    it.effect(`rejects invalid management name ${JSON.stringify(name)}`, () =>
      Effect.gen(function*() {
        expect((yield* errorOf(fixture().api.validateName("stream", name))).reason).toContain("Invalid stream name")
      }))
  }

  it.effect("working is repeatable while final acknowledgements are exclusive", () =>
    Effect.gen(function*() {
      const { connection, publications } = fixture()
      const message = yield* JetStreamMessage.make(
        response("{\"amount\":7}", "$JS.ACK.orders.worker.1.7.1.1700000000123456789.0"),
        connection
      )
      yield* message.working
      yield* message.working
      yield* Effect.all([message.ack, message.ack, message.term("done")], { concurrency: "unbounded" })
      expect(publications.map((entry) => entry.payload)).toEqual(["+WPI", "+WPI", "+ACK"])
      expect(message.timestampNanos).toBe(BigInt("1700000000123456789"))
      expect(message.info.domain).toBe("")
      expect(yield* message.decode(Schema.Struct({ amount: Schema.Number }))).toEqual({ amount: 7 })
      expect(yield* message.json()).toEqual({ amount: 7 })
      expect(yield* message.ackAck()).toBe(false)
    }))

  it.effect("next combines final ack with a nanos pull envelope", () =>
    Effect.gen(function*() {
      const { connection, publications } = fixture()
      const message = yield* JetStreamMessage.make(
        response("body", "$JS.ACK.east.hash.orders.worker.2.8.3.1700000000000000000.4"),
        connection
      )
      yield* message.next("_INBOX.next", { batch: 2, expires: 1000 })
      yield* message.ack
      expect(publications).toEqual([{
        subject: "$JS.ACK.east.hash.orders.worker.2.8.3.1700000000000000000.4",
        payload: "+NXT {\"batch\":2,\"expires\":1000000000}",
        options: { reply: "_INBOX.next" }
      }])
      expect(message.redelivered).toBe(true)
      expect(message.info.domain).toBe("east")
    }))

  for (
    const reply of [
      undefined,
      "$JS.ACK.bad",
      "$JS.ACK.orders.worker.nope.1.1.1.0",
      "$JS.ACK.orders.worker.1.1.1.invalid.0"
    ]
  ) {
    it.effect(`rejects malformed ack metadata ${String(reply)}`, () =>
      Effect.gen(function*() {
        expect((yield* errorOf(JetStreamMessage.make(response("body", reply), fixture().connection))).reason).toBe(
          "Invalid JetStream ack subject"
        )
      }))
  }

  it.effect("confirmed acknowledgement uses caller timeout once", () =>
    Effect.gen(function*() {
      const timeouts: Array<number | undefined> = []
      const { connection } = fixture((_subject, payload, options) =>
        Effect.sync(() => {
          expect(payload).toBe("+ACK")
          timeouts.push(options?.timeout)
          return response("")
        })
      )
      const message = yield* JetStreamMessage.make(response("body", "$JS.ACK.orders.worker.1.1.1.1.0"), connection)
      expect(yield* message.ackAck({ timeout: 42 })).toBe(true)
      expect(yield* message.ackAck()).toBe(false)
      expect(timeouts).toEqual([42])
    }))

  it.effect("stored messages preserve binary data, headers and reject invalid dates", () =>
    Effect.gen(function*() {
      const headers = NATSHeaders.headers()
      headers.set("X-Test", "binary")
      const message = yield* JetStreamStoredMessage.fromResponse({
        subject: "orders",
        seq: 1,
        time: "2026-01-01T00:00:00Z",
        data: btoa(String.fromCharCode(0, 255, 128)),
        hdrs: btoa(new TextDecoder().decode(headers.encode()))
      })
      expect(Array.from(message.data)).toEqual([0, 255, 128])
      expect(message.header.get("X-Test")).toBe("binary")
      expect(
        (yield* errorOf(
          JetStreamStoredMessage.fromResponse({ subject: "orders", seq: 1, time: "invalid", data: "", hdrs: "" })
        )).reason
      ).toBe("Invalid stored message timestamp")
      expect((yield* errorOf(message.json()))._tag).toBe("JetStreamStoredMessageError")
    }))

  it.effect("direct responses validate metadata and preserve cursors", () =>
    Effect.gen(function*() {
      const headers = NATSHeaders.headers()
      for (
        const [key, value] of Object.entries({
          "Nats-Subject": "orders",
          "Nats-Sequence": "8",
          "Nats-Time-Stamp": "2026-01-01T00:00:00Z",
          "Nats-Last-Sequence": "7",
          "Nats-Num-Pending": "2"
        })
      ) headers.set(key, value)
      const message = yield* JetStreamStoredMessage.fromDirect(response("body", undefined, headers))
      expect([message.seq, message.lastSequence, message.pending]).toEqual([8, 7, 2])
      expect((yield* errorOf(JetStreamStoredMessage.fromDirect(response("body")))).reason).toBe(
        "Direct message is missing headers"
      )
      headers.set("Nats-Sequence", "invalid")
      expect((yield* errorOf(JetStreamStoredMessage.fromDirect(response("body", undefined, headers)))).reason).toBe(
        "Invalid direct message headers"
      )
    }))

  it.effect("serializing cyclic requests fails before wire IO", () =>
    Effect.gen(function*() {
      const cyclic: { nested?: unknown } = {}
      cyclic.nested = cyclic
      const error = yield* errorOf(fixture().api.api("CHECK", cyclic, Schema.Unknown))
      expect(error.reason).toBe("Invalid JetStream request")
    }))

  it.effect("request transport failures remain typed and identify the API subject", () =>
    Effect.gen(function*() {
      const api = fixture(() => Effect.fail(new NATSError.NATSConnectionError({ reason: "closed" }))).api
      expect((yield* errorOf(api.api("INFO", {}, Schema.Unknown))).reason).toBe(
        "JetStream request failed: $JS.API.INFO: closed"
      )
    }))

  it.effect("JSON syntax and schema failures are typed on delivered messages", () =>
    Effect.gen(function*() {
      const connection = fixture().connection
      const reply = "$JS.ACK.orders.worker.1.1.1.1.0"
      const badJson = yield* JetStreamMessage.make(response("{", reply), connection)
      expect((yield* errorOf(badJson.json()))._tag).toBe("JetStreamMessageError")
      const wrongShape = yield* JetStreamMessage.make(response("{\"amount\":\"seven\"}", reply), connection)
      expect((yield* errorOf(wrongShape.decode(Schema.Struct({ amount: Schema.Number }))))._tag).toBe(
        "JetStreamMessageError"
      )
    }))

  it.effect("negative acknowledgement delays are nanos and termination reasons survive", () =>
    Effect.gen(function*() {
      const { connection, publications } = fixture()
      const reply = "$JS.ACK.orders.worker.1.1.1.1.0"
      const nak = yield* JetStreamMessage.make(response("body", reply), connection)
      yield* nak.nak(25)
      yield* nak.working
      const term = yield* JetStreamMessage.make(response("body", reply), connection)
      yield* term.term("invalid order")
      expect(publications.map((entry) => entry.payload)).toEqual(["-NAK {\"delay\":25000000}", "+TERM invalid order"])
    }))

  it.effect("direct not-found is optional while other broker statuses fail", () =>
    Effect.gen(function*() {
      const missing = fixture(() =>
        Effect.succeed(response("", undefined, NATSHeaders.headers(404, "No Messages")))
      ).api
      expect(yield* JetStreamDirectStreamAPI.make(missing).getMessage("orders", { seq: 1 })).toEqual(Option.none())
      const failure =
        fixture(() => Effect.succeed(response("", undefined, NATSHeaders.headers(503, "Unavailable")))).api
      expect((yield* errorOf(JetStreamDirectStreamAPI.make(failure).getMessage("orders", { seq: 1 }))).reason).toBe(
        "Unavailable"
      )
    }))

  it.effect("direct last subject queries encode in subject with no request payload", () =>
    Effect.gen(function*() {
      const { api } = fixture((subject, payload) =>
        Effect.sync(() => {
          expect(subject).toBe("$JS.API.DIRECT.GET.orders.orders.created")
          expect(payload).toBeUndefined()
          return response("", undefined, NATSHeaders.headers(404, "No Messages"))
        })
      )
      yield* JetStreamDirectStreamAPI.make(api).getMessage("orders", { last_by_subj: "orders.created" })
    }))

  it.effect("direct start-time queries normalize Date to ISO", () =>
    Effect.gen(function*() {
      const { api } = fixture((_subject, payload) =>
        Effect.sync(() => {
          expect(payload).toBe("{\"start_time\":\"2026-01-01T00:00:00.000Z\"}")
          return response("", undefined, NATSHeaders.headers(404, "No Messages"))
        })
      )
      yield* JetStreamDirectStreamAPI.make(api).getMessage("orders", { start_time: new Date("2026-01-01T00:00:00Z") })
    }))

  it.effect("invalid direct timestamps and stored base64 are rejected", () =>
    Effect.gen(function*() {
      const headers = NATSHeaders.headers()
      headers.set("Nats-Subject", "orders")
      headers.set("Nats-Sequence", "1")
      headers.set("Nats-Time-Stamp", "invalid")
      expect((yield* errorOf(JetStreamStoredMessage.fromDirect(response("", undefined, headers)))).reason).toBe(
        "Invalid direct message timestamp"
      )
      expect(
        (yield* errorOf(
          JetStreamStoredMessage.fromResponse({
            subject: "orders",
            seq: 1,
            time: "2026-01-01T00:00:00Z",
            data: "!",
            hdrs: ""
          })
        )).reason
      ).toBe("Invalid stored message response")
    }))

  it.effect("publish retries transient transport timeouts without retrying broker errors", () =>
    Effect.gen(function*() {
      let requests = 0
      const { connection } = fixture(() =>
        Effect.suspend(() => {
          requests++
          return requests === 1
            ? Effect.fail(new NATSError.NATSConnectionError({ reason: "Request timed out" }))
            : Effect.succeed(response("{\"stream\":\"orders\",\"seq\":1}"))
        })
      )
      const ack = yield* JetStreamClient.make(connection).publish("orders", "payload", { retries: 2 })
      expect(ack.seq).toBe(1)
      expect(requests).toBe(2)
      let rejectedRequests = 0
      const rejected = fixture(() =>
        Effect.sync(() => {
          rejectedRequests++
          return response("{\"error\":{\"code\":409,\"err_code\":10071,\"description\":\"wrong sequence\"}}")
        })
      ).connection
      yield* errorOf(JetStreamClient.make(rejected).publish("orders", "payload", { retries: 4 }))
      expect(rejectedRequests).toBe(1)
    }))

  it.effect("cluster peers default only optional omitted false and zero values", () =>
    Effect.gen(function*() {
      expect(yield* Schema.decodeUnknownEffect(Wire.PeerInfo)({ name: "peer", current: false, active: 0 })).toEqual({
        name: "peer",
        current: false,
        offline: false,
        active: 0,
        lag: 0
      })
      const rejected = yield* Schema.decodeUnknownEffect(Wire.PeerInfo)({ name: "peer", offline: "false" }).pipe(
        Effect.match({ onSuccess: () => false, onFailure: () => true })
      )
      expect(rejected).toBe(true)
    }))

  it.effect("mirror configs accept broker-omitted zero fields while retaining required limits", () =>
    Effect.gen(function*() {
      const config = {
        name: "mirror",
        retention: "limits",
        storage: "memory",
        max_consumers: -1,
        max_msgs: -1,
        max_bytes: -1,
        max_age: 0,
        max_msgs_per_subject: -1,
        discard: "old",
        num_replicas: 3,
        mirror: { name: "source" }
      }
      const decoded = yield* Schema.decodeUnknownEffect(Wire.StreamConfig)(config)
      expect(decoded.subjects).toEqual([])
      expect(decoded.duplicate_window).toBe(0)
      expect(decoded.max_msg_size).toBe(0)
      expect(yield* Schema.decodeUnknownEffect(Wire.Republish)({ dest: "orders.copy" })).toEqual({
        src: "",
        dest: "orders.copy"
      })
      expect(
        yield* Schema.decodeUnknownEffect(Wire.StreamConfig)({ ...config, max_msgs: "unlimited" }).pipe(
          Effect.match({ onSuccess: () => false, onFailure: () => true })
        )
      ).toBe(true)
    }))

  for (
    const metadata of [
      { total: -1, offset: 0, limit: 2 },
      { total: 2.5, offset: 0, limit: 2 },
      { total: 10, offset: -2, limit: 2 },
      { total: 10, offset: 4, limit: 2 },
      { total: 10, offset: 0, limit: -1 }
    ]
  ) {
    it.effect(`rejects unsafe pagination metadata ${JSON.stringify(metadata)}`, () =>
      Effect.gen(function*() {
        const { api } = fixture(() => Effect.succeed(response(JSON.stringify({ ...metadata, names: [] }))))
        expect((yield* errorOf(api.list("STREAM.NAMES", {}, "names", Schema.String).next())).reason).toBe(
          "Invalid JetStream pagination metadata"
        )
      }))
  }

  it.effect("stream alternates default omitted domains but require broker names and clusters", () =>
    Effect.gen(function*() {
      expect(yield* Schema.decodeUnknownEffect(Wire.StreamAlternate)({ name: "mirror", cluster: "east" })).toEqual({
        name: "mirror",
        cluster: "east",
        domain: ""
      })
      for (
        const value of [{ name: "mirror" }, { cluster: "east" }, { name: "mirror", cluster: "east", domain: false }]
      ) {
        expect(
          yield* Schema.decodeUnknownEffect(Wire.StreamAlternate)(value).pipe(Effect.match({
            onSuccess: () => false,
            onFailure: () => true
          }))
        ).toBe(true)
      }
      expect(
        yield* Schema.decodeUnknownEffect(Wire.PeerInfo)({ name: "peer" }).pipe(Effect.match({
          onSuccess: () => false,
          onFailure: () => true
        }))
      ).toBe(true)
    }))

  it.effect("out-of-range acknowledgement timestamps fail in the typed channel", () =>
    Effect.gen(function*() {
      const message = response("body", "$JS.ACK.orders.worker.1.1.1.999999999999999999999999999999999.0")
      expect((yield* errorOf(JetStreamMessage.make(message, fixture().connection))).reason).toBe(
        "Invalid JetStream timestamp"
      )
    }))
})
