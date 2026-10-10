import * as Effect from "effect/Effect"

const encoder = new TextEncoder()
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const base32 = (bytes: Uint8Array): string => {
  let value = 0
  let bits = 0
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
const checkedKey = (data: Uint8Array): string => {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) === 0 ? 0 : 0x1021)) & 0xffff
  }
  const checked = new Uint8Array(data.length + 2)
  checked.set(data)
  checked.set([crc & 255, crc >>> 8], data.length)
  return base32(checked)
}
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
const keyPair = async (prefix: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const der = new Uint8Array(48)
  der.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32])
  der.set(bytes, 16)
  const privateKey = await crypto.subtle.importKey("pkcs8", der, "Ed25519", true, ["sign"])
  const jwk = await crypto.subtle.exportKey("jwk", privateKey)
  if (jwk.x === undefined) throw new Error("Missing JWT fixture public key")
  const publicBytes = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))
  const publicData = new Uint8Array(33)
  publicData[0] = prefix
  publicData.set(publicBytes, 1)
  const seedData = new Uint8Array(34)
  seedData.set([144 | (prefix >>> 5), (prefix & 31) << 3])
  seedData.set(bytes, 2)
  const seed = encoder.encode(checkedKey(seedData))
  bytes.fill(0)
  der.fill(0)
  seedData.fill(0)
  return { publicKey: checkedKey(publicData), privateKey, seed }
}
type KeyPair = Awaited<ReturnType<typeof keyPair>>
const jwt = async (
  issuer: KeyPair,
  subject: string,
  type: "operator" | "account" | "user",
  nats: Record<string, unknown> = {},
  times: { iat?: number; exp?: number } = {}
): Promise<string> => {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    iss: issuer.publicKey,
    sub: subject,
    nats: { type, version: 2, ...nats },
    ...times
  }
  const jti = base32(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(payload)))))
  const content = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" }))) + "." +
    base64url(encoder.encode(JSON.stringify({ jti, ...payload })))
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", issuer.privateKey, encoder.encode(content)))
  return content + "." + base64url(signature)
}
export const makeJWTFixture = (revoked = false, expiration?: { user?: number; account?: number }) =>
  Effect.promise(async () => {
    const operator = await keyPair(112)
    const account = await keyPair(0)
    const first = await keyPair(160)
    const second = await keyPair(160)
    const now = Math.floor(Date.now() / 1000)
    const operatorJWT = await jwt(operator, operator.publicKey, "operator")
    const accountJWT = await jwt(
      operator,
      account.publicKey,
      "account",
      {
        limits: { subs: -1, conn: -1, imports: -1, exports: -1, data: -1, payload: -1, wildcards: true },
        ...(revoked ? { revocations: { [first.publicKey]: now } } : {})
      },
      expiration?.account === undefined ? {} : { exp: now + expiration.account }
    )
    const firstJWT = await jwt(
      account,
      first.publicKey,
      "user",
      { pub: {}, sub: {}, subs: -1, data: -1, payload: -1 },
      { iat: now - 60, ...(expiration?.user === undefined ? {} : { exp: now + expiration.user }) }
    )
    const expiredJWT = await jwt(account, first.publicKey, "user", {
      pub: {},
      sub: {},
      subs: -1,
      data: -1,
      payload: -1
    }, {
      iat: now - 120,
      exp: now - 60
    })
    const bearerJWT = await jwt(account, first.publicKey, "user", {
      pub: {},
      sub: {},
      subs: -1,
      data: -1,
      payload: -1,
      bearer_token: true
    })
    const secondJWT = await jwt(account, second.publicKey, "user", {
      pub: {},
      sub: {},
      subs: -1,
      data: -1,
      payload: -1
    })
    return {
      first,
      second,
      firstJWT,
      expiredJWT,
      secondJWT,
      bearerJWT,
      renewUserJWT: () =>
        jwt(account, first.publicKey, "user", {
          pub: {},
          sub: {},
          subs: -1,
          data: -1,
          payload: -1
        }, { exp: Math.floor(Date.now() / 1000) + (expiration?.user ?? 2) }),
      config: [
        `operator: "${operatorJWT}"`,
        "resolver: MEMORY",
        `resolver_preload: { ${account.publicKey}: "${accountJWT}" }`
      ].join("\n")
    }
  })

export const makeJetStreamJWTFixture = () =>
  Effect.promise(async () => {
    const operator = await keyPair(112)
    const system = await keyPair(0)
    const account = await keyPair(0)
    const user = await keyPair(160)
    const operatorJWT = await jwt(operator, operator.publicKey, "operator", { system_account: system.publicKey })
    const unlimited = { subs: -1, conn: -1, imports: -1, exports: -1, data: -1, payload: -1, wildcards: true }
    const systemJWT = await jwt(operator, system.publicKey, "account", { limits: unlimited })
    const accountJWT = await jwt(operator, account.publicKey, "account", {
      limits: {
        ...unlimited,
        tiered_limits: {
          R1: { memory_storage: -1, disk_storage: 1_048_576, consumer: -1, streams: -1, max_ack_pending: -1 }
        }
      }
    })
    const bearerJWT = await jwt(account, user.publicKey, "user", {
      pub: {},
      sub: {},
      subs: -1,
      data: -1,
      payload: -1,
      bearer_token: true
    })
    return {
      bearerJWT,
      config: [
        `operator: "${operatorJWT}"`,
        "resolver: MEMORY",
        `resolver_preload: { ${system.publicKey}: "${systemJWT}", ${account.publicKey}: "${accountJWT}" }`
      ].join("\n")
    }
  })
