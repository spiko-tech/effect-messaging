/** SASL authentication evaluated afresh for each physical session.
 * @since 1.0.0-beta.0
 */
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { AMQPConnectionError } from "./AMQPError.ts"
import * as Codec from "./internal/codec.ts"
import * as Configuration from "./internal/configuration.ts"
import * as Protocol from "./internal/protocol.ts"

/** Callbacks require no services and may perform multiple challenge rounds.
 * Credentials remain redacted until the mechanism encodes its response.
 * @since 1.0.0-beta.0
 * @category models
 */
export interface Mechanism {
  readonly mechanism: string
  readonly initialResponse: (
    username: string,
    password: Redacted.Redacted<string>
  ) => Effect.Effect<Uint8Array, AMQPConnectionError>
  readonly challenge?: (challenge: Uint8Array) => Effect.Effect<Uint8Array, AMQPConnectionError>
}

const utf8 = Protocol.text.pipe(Schema.decodeTo(
  Schema.Uint8Array,
  SchemaTransformation.transform({
    decode: (value): Uint8Array => new TextEncoder().encode(value),
    encode: (bytes) => new TextDecoder().decode(bytes)
  })
))
const encode = (value: string) =>
  Schema.decodeUnknownEffect(utf8)(value).pipe(
    Effect.mapError(() =>
      new AMQPConnectionError({ reason: "Authentication response encoding failed", permanent: true })
    )
  )

/** Default username/password mechanism. NUL credentials fail locally without exposing their values.
 * @since 1.0.0-beta.0
 * @category mechanisms
 */
export const PLAIN: Mechanism = {
  mechanism: "PLAIN",
  initialResponse: Effect.fn("AMQPAuthentication.PLAIN")(function*(username, password) {
    const value = Redacted.value(password)
    if (username.includes("\0") || value.includes("\0")) {
      return yield* new AMQPConnectionError({ reason: "PLAIN credentials must not contain NUL", permanent: true })
    }
    return yield* encode(`\0${username}\0${value}`)
  })
}

/** RabbitMQ's field-table SASL mechanism; the table length prefix is excluded from the response.
 * @since 1.0.0-beta.0
 * @category mechanisms
 */
export const AMQPLAIN: Mechanism = {
  mechanism: "AMQPLAIN",
  initialResponse: Effect.fn("AMQPAuthentication.AMQPLAIN")(function*(username, password) {
    const table = yield* Codec.encodeFieldTable({ LOGIN: username, PASSWORD: Redacted.value(password) }).pipe(
      Effect.mapError(() => new AMQPConnectionError({ reason: "AMQPLAIN response encoding failed", permanent: true }))
    )
    return table.slice(4)
  })
}

/** Use transport-established identity (normally a TLS client certificate).
 * An empty authorization identity is the default, matching amqplib.
 * @since 1.0.0-beta.0
 * @category mechanisms
 */
export const external = (authorizationIdentity = ""): Mechanism => ({
  mechanism: "EXTERNAL",
  initialResponse: () => encode(authorizationIdentity)
})

/** Empty authorization identity; transport authentication is still required.
 * @since 1.0.0-beta.0
 * @category mechanisms
 */
export const EXTERNAL: Mechanism = external()

/** @since 1.0.0-beta.0 @category models */
export type Authentication = "PLAIN" | "AMQPLAIN" | "EXTERNAL" | Mechanism

const mechanismSchema = Schema.Struct({
  mechanism: Schema.NonEmptyString,
  initialResponse: Schema.declare<Mechanism["initialResponse"]>(
    (value): value is Mechanism["initialResponse"] => Predicate.isFunction(value)
  ),
  challenge: Schema.optionalKey(Schema.declare<NonNullable<Mechanism["challenge"]>>(
    (value): value is NonNullable<Mechanism["challenge"]> => Predicate.isFunction(value)
  ))
})
const decodeMechanism = Schema.decodeUnknownEffect(Configuration.snapshot(mechanismSchema, [
  "mechanism",
  "initialResponse",
  "challenge"
]))

/** @internal */
export const resolve = Effect.fnUntraced(function*(authentication: Authentication = "PLAIN") {
  if (authentication === "PLAIN") return PLAIN
  if (authentication === "AMQPLAIN") return AMQPLAIN
  if (authentication === "EXTERNAL") return EXTERNAL
  const captured = yield* decodeMechanism(authentication).pipe(
    Effect.mapError(() => new AMQPConnectionError({ reason: "Invalid authentication mechanism", permanent: true }))
  )
  return yield* Effect.try({
    try: (): Mechanism =>
      Object.freeze({
        mechanism: captured.mechanism,
        initialResponse: Function.prototype.bind.call(captured.initialResponse, authentication),
        ...(captured.challenge === undefined ? {} : {
          challenge: Function.prototype.bind.call(captured.challenge, authentication)
        })
      }),
    catch: () => new AMQPConnectionError({ reason: "Invalid authentication callbacks", permanent: true })
  })
})
