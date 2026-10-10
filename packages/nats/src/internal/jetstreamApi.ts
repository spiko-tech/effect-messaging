/** @internal */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as JetStreamLister from "../JetStreamLister.ts"
import type * as JetStreamTypes from "../JetStreamTypes.ts"
import type * as NATSConnection from "../NATSConnection.ts"
import * as NATSHeaders from "../NATSHeaders.ts"
import * as Wire from "./jetstreamSchemas.ts"

export class JetStreamApiError extends Schema.TaggedError<JetStreamApiError>()("JetStreamApiError", {
  reason: Schema.String,
  apiError: Schema.optionalKey(Wire.ApiError),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

const Version = Schema.Tuple([
  Schema.NumberFromString.check(Schema.isFinite()),
  Schema.NumberFromString.check(Schema.isFinite()),
  Schema.NumberFromString.check(Schema.isFinite())
])

const Envelope = Schema.Struct({ error: Schema.optionalKey(Wire.ApiError) })

export const make = (
  connection: NATSConnection.NATSConnection,
  options: JetStreamTypes.JetStreamManagerOptions = {}
) => {
  const prefix = (options.domain ? `$JS.${options.domain}.API` : options.apiPrefix ?? "$JS.API").replace(/\.$/, "")
  const timeout = options.timeout ?? 5000
  const normalizedOptions = { ...options, apiPrefix: prefix, timeout }
  const configuration = Effect.gen(function*() {
    const validPrefix = Schema.String.check(Schema.isPattern(/^[^\s*>]+$/))
    yield* Schema.decodeUnknownEffect(validPrefix)(prefix).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream apiPrefix", cause }))
    )
    yield* Schema.decodeUnknownEffect(Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite()))(timeout)
      .pipe(Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream timeout", cause })))
    const inbox = yield* connection.createInbox
    const watcherPrefix = options.watcherPrefix ?? inbox.slice(0, inbox.lastIndexOf("."))
    yield* Schema.decodeUnknownEffect(validPrefix)(watcherPrefix).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream watcherPrefix", cause }))
    )
    return watcherPrefix === "_INBOX" && options.watcherPrefix === undefined
      ? normalizedOptions
      : { ...normalizedOptions, watcherPrefix }
  })
  const request = Effect.fn("JetStream.request")(function*<A>(
    subject: string,
    payload: unknown,
    schema: Schema.ConstraintDecoder<A>,
    requestTimeout = timeout,
    headers?: NATSHeaders.MsgHdrs
  ) {
    yield* configuration
    const data = yield* Effect.try({
      try: () => JSON.stringify(payload),
      catch: (cause) => new JetStreamApiError({ reason: "Invalid JetStream request", cause })
    })
    const message = yield* connection.request(subject, data, {
      timeout: requestTimeout,
      ...(headers ? { headers } : {})
    }).pipe(
      Effect.mapError((cause) =>
        new JetStreamApiError({ reason: `JetStream request failed: ${subject}: ${cause.reason}`, cause })
      )
    )
    return yield* decode(message.data, schema)
  })
  const decode = Effect.fnUntraced(function*<A>(data: Uint8Array, schema: Schema.ConstraintDecoder<A>) {
    const text = new TextDecoder().decode(data)
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream JSON response", cause }))
    )
    const envelope = yield* Schema.decodeUnknownEffect(Envelope)(value).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream response envelope", cause }))
    )
    if (envelope.error) {
      return yield* new JetStreamApiError({ reason: envelope.error.description, apiError: envelope.error })
    }
    return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream response", cause }))
    )
  })
  const api = <A>(suffix: string, payload: unknown, schema: Schema.ConstraintDecoder<A>, minimumApiLevel = 0) => {
    const headers = options.sendRequiredApiLevel && minimumApiLevel > 0 ? NATSHeaders.headers() : undefined
    if (headers) headers.set("Nats-Required-Api-Level", String(minimumApiLevel))
    return request(`${prefix}.${suffix}`, payload, schema, timeout, headers)
  }
  const requireVersion = Effect.fnUntraced(function*(feature: string, minimum: readonly [number, number, number]) {
    const server = Option.getOrUndefined(connection.info)
    if (!server) return yield* new JetStreamApiError({ reason: "Connection info is unavailable" })
    const version = yield* Schema.decodeUnknownEffect(Version)(
      server.version.replace(/^v/, "").split("-")[0]?.split(".")
    ).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid NATS server version", cause }))
    )
    for (let index = 0; index < 3; index++) {
      if ((version[index] ?? 0) > (minimum[index] ?? 0)) return
      if ((version[index] ?? 0) < (minimum[index] ?? 0)) {
        return yield* new JetStreamApiError({
          reason: `${feature} requires NATS server ${minimum.join(".")}`
        })
      }
    }
  })
  const list = <A>(suffix: string, payload: object, field: string, schema: Schema.ConstraintDecoder<A>) => {
    const pageSchema = Schema.StructWithRest(
      Schema.Struct({
        total: Schema.Number,
        offset: Schema.Number,
        limit: Schema.Number
      }),
      [Schema.Record(Schema.String, Schema.Unknown)]
    )
    const page = Effect.fnUntraced(function*(offset: number) {
      const result = yield* api(suffix, { ...payload, offset }, pageSchema)
      if (
        !Number.isInteger(result.total) || result.total < 0 ||
        !Number.isInteger(result.offset) || result.offset !== offset ||
        !Number.isInteger(result.limit) || result.limit < 0
      ) return yield* new JetStreamApiError({ reason: "Invalid JetStream pagination metadata" })
      const values = yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result[field] ?? []).pipe(
        Effect.mapError((cause) => new JetStreamApiError({ reason: "Invalid JetStream page", cause }))
      )
      const next = result.offset + result.limit
      return [values, next < result.total && result.limit > 0 ? Option.some(next) : Option.none<number>()] as const
    })
    return JetStreamLister.make(page)
  }
  const validateName = (kind: string, name: string) =>
    Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[^.*>\s/\\]+$/)))(name).pipe(
      Effect.mapError((cause) => new JetStreamApiError({ reason: `Invalid ${kind} name: ${name}`, cause })),
      Effect.asVoid
    )
  return {
    connection,
    prefix,
    timeout,
    options: normalizedOptions,
    configuration,
    request,
    decode,
    api,
    list,
    validateName,
    requireVersion
  }
}

export type JetStreamApi = ReturnType<typeof make>

const ErrorMetadata = Schema.Struct({
  reason: Schema.String,
  apiError: Schema.optionalKey(Wire.ApiError)
})
const wrapError = <E>(
  ErrorClass: new(options: {
    reason: string
    cause?: unknown
    apiError?: { code: number; err_code: number; description: string }
  }) => E
) =>
(cause: unknown): E => {
  const metadata = Schema.decodeUnknownOption(ErrorMetadata)(cause)
  const reason = Option.isSome(metadata) ? metadata.value.reason : "JetStream operation failed"
  const apiError = Option.isSome(metadata) ? metadata.value.apiError : undefined
  return new ErrorClass({ reason, cause, ...(apiError ? { apiError } : {}) })
}
export const mapError = <E>(
  ErrorClass: new(options: {
    reason: string
    cause?: unknown
    apiError?: { code: number; err_code: number; description: string }
  }) => E
) => Effect.mapError(wrapError(ErrorClass))

export const mapStreamError = <E>(
  ErrorClass: new(options: {
    reason: string
    cause?: unknown
    apiError?: { code: number; err_code: number; description: string }
  }) => E
) => Stream.mapError(wrapError(ErrorClass))
