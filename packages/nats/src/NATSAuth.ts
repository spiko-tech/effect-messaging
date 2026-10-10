/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as NATSOptions from "./NATSOptions.ts"

/** @since 0.1.0 */
export class NATSAuthError extends Schema.TaggedError<NATSAuthError>()("NATSAuthError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}
/** @since 0.1.0 */
export interface Auth {
  auth_token?: string
  user?: string
  pass?: string
  nkey?: string
  sig?: string
  jwt?: string
}
/** @since 0.1.0 */
export type Authenticator = (nonce?: string) => Auth | Promise<Auth> | Effect.Effect<Auth, NATSAuthError>
/** @since 0.1.0 */
export type EffectAuthenticator = (nonce?: string) => Effect.Effect<Auth, NATSAuthError>
/** @since 0.1.0 */
export const noAuthFn = (): EffectAuthenticator => () => Effect.succeed({})
/** @since 0.1.0 */
export const tokenAuthenticator = (token: string | (() => string)): EffectAuthenticator => () =>
  Effect.try({
    try: () => ({ auth_token: typeof token === "string" ? token : token() }),
    catch: (cause) => new NATSAuthError({ message: "Unable to resolve token", cause })
  })
/** @since 0.1.0 */
export const usernamePasswordAuthenticator = (
  user: string | (() => string),
  pass?: string | (() => string)
): EffectAuthenticator =>
() =>
  Effect.try({
    try: () => ({
      user: typeof user === "string" ? user : user(),
      ...(pass === undefined ? {} : { pass: typeof pass === "string" ? pass : pass() })
    }),
    catch: (cause) => new NATSAuthError({ message: "Unable to resolve credentials", cause })
  })
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const crc16 = (bytes: Uint8Array): number => {
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) !== 0 ? 0x1021 : 0)) & 0xffff
  }
  return crc
}
const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0
  let value = 0
  let result = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += alphabet[(value >>> bits) & 31]
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31]
  return result
}
const base32Decode = (input: string): Uint8Array => {
  let bits = 0
  let value = 0
  const result: Array<number> = []
  for (const char of input) {
    const index = alphabet.indexOf(char)
    if (index === -1) throw new Error("Invalid NKey Base32 character")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      result.push((value >>> bits) & 255)
    }
  }
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) throw new Error("Invalid NKey Base32 padding")
  return Uint8Array.from(result)
}
const decodeSeed = (input: Uint8Array): { prefix: number; seed: Uint8Array } => {
  const bytes = base32Decode(new TextDecoder("utf-8", { fatal: true }).decode(input))
  if (bytes.length !== 36) throw new Error("NKey seed must contain 32 bytes")
  const data = bytes.subarray(0, 34)
  const checksum = crc16(data)
  if (bytes[34] !== (checksum & 255) || bytes[35] !== (checksum >>> 8)) throw new Error("Invalid NKey checksum")
  if (((bytes[0] ?? 0) & 248) !== 144 || ((bytes[1] ?? 0) & 7) !== 0) throw new Error("Invalid NKey seed prefix")
  const prefix = (((bytes[0] ?? 0) & 7) << 5) | (((bytes[1] ?? 0) & 248) >>> 3)
  if (![0, 16, 104, 112, 160].includes(prefix)) throw new Error("Invalid NKey public prefix")
  return { prefix, seed: bytes.slice(2, 34) }
}
const publicNKey = (prefix: number, publicKey: Uint8Array): string => {
  const bytes = new Uint8Array(35)
  bytes[0] = prefix
  bytes.set(publicKey, 1)
  const checksum = crc16(bytes.subarray(0, 33))
  bytes[33] = checksum & 255
  bytes[34] = checksum >>> 8
  return base32Encode(bytes)
}
/** @since 0.1.0 */
export const nkeyAuthenticator = (seed?: Uint8Array | (() => Uint8Array)): EffectAuthenticator => (nonce) => {
  if (seed === undefined) return Effect.succeed({})
  return Effect.tryPromise({
    try: async () => {
      const decoded = decodeSeed(typeof seed === "function" ? seed() : seed)
      const der = new Uint8Array(48)
      der.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32])
      der.set(decoded.seed, 16)
      try {
        const privateKey = await globalThis.crypto.subtle.importKey("pkcs8", der, "Ed25519", true, ["sign"])
        const jwk = await globalThis.crypto.subtle.exportKey("jwk", privateKey)
        if (jwk.x === undefined) throw new Error("Ed25519 public key missing")
        const publicKey = Uint8Array.from(
          atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")),
          (char) => char.charCodeAt(0)
        )
        const signed = nonce === undefined || nonce === "" ? undefined : await globalThis.crypto.subtle.sign(
          "Ed25519",
          privateKey,
          new TextEncoder().encode(nonce)
        )
        const signature = signed === undefined ? "" : btoa(String.fromCharCode(...new Uint8Array(signed)))
        return { nkey: publicNKey(decoded.prefix, publicKey), sig: signature }
      } finally {
        decoded.seed.fill(0)
        der.fill(0)
      }
    },
    catch: (cause) => new NATSAuthError({ message: "NKey authentication failed", cause })
  })
}
/** @since 0.1.0 */
export const jwtAuthenticator = (
  jwt: string | (() => string),
  seed?: Uint8Array | (() => Uint8Array)
): EffectAuthenticator =>
  Effect.fnUntraced(function*(nonce?: string) {
    const auth = yield* nkeyAuthenticator(seed)(nonce)
    const token = yield* Effect.try({
      try: () => typeof jwt === "string" ? jwt : jwt(),
      catch: (cause) => new NATSAuthError({ message: "Unable to resolve JWT", cause })
    })
    return { ...auth, jwt: token }
  })
/** @since 0.1.0 */
export const credsAuthenticator = (credentials: Uint8Array | (() => Uint8Array)): EffectAuthenticator =>
  Effect.fnUntraced(function*(nonce?: string) {
    const parsed = yield* Effect.try({
      try: () => {
        const text = new TextDecoder().decode(typeof credentials === "function" ? credentials() : credentials)
        const jwt = /-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*------END NATS USER JWT------/.exec(text)?.[1]
        const seed = /-----BEGIN USER NKEY SEED-----\s*([\s\S]*?)\s*------END USER NKEY SEED------/.exec(text)?.[1]
        if (jwt === undefined || seed === undefined || jwt.trim() === "" || seed.trim() === "") {
          throw new Error("Invalid NATS credentials file")
        }
        return { jwt: jwt.trim(), seed: new TextEncoder().encode(seed.trim()) }
      },
      catch: (cause) => new NATSAuthError({ message: "Unable to decode credentials", cause })
    })
    return yield* jwtAuthenticator(parsed.jwt, parsed.seed)(nonce).pipe(
      Effect.ensuring(Effect.sync(() => parsed.seed.fill(0)))
    )
  })

/** @since 0.1.0 */
export const resolveAuthenticator = (authenticator: Authenticator, nonce?: string) =>
  Effect.suspend(() => {
    try {
      const auth = authenticator(nonce)
      if (Effect.isEffect(auth)) return auth
      return Effect.tryPromise({
        try: () => Promise.resolve(auth),
        catch: (cause) => new NATSAuthError({ message: "Authenticator failed", cause })
      })
    } catch (cause) {
      return Effect.fail(new NATSAuthError({ message: "Authenticator failed", cause }))
    }
  })
/** @since 0.1.0 */
export const buildAuthenticator = (options: NATSOptions.ConnectionOptions): EffectAuthenticator => {
  const authenticators: Array<Authenticator> = []
  if (options.authenticator !== undefined) {
    authenticators.push(...(Array.isArray(options.authenticator) ? options.authenticator : [options.authenticator]))
  }
  if (options.token !== undefined) authenticators.push(tokenAuthenticator(options.token))
  if (options.user !== undefined) authenticators.push(usernamePasswordAuthenticator(options.user, options.pass))
  return Effect.fnUntraced(function*(nonce?: string) {
    const values = yield* Effect.forEach(authenticators, (authenticator) => resolveAuthenticator(authenticator, nonce))
    const combined: Auth = {}
    for (const auth of values) Object.assign(combined, auth)
    return combined
  })
}
