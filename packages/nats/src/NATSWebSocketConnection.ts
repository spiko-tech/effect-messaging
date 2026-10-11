/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Socket from "effect/socket/Socket"
import * as Client from "./internal/client.ts"
import * as Services from "./internal/clientServices.ts"
import * as NATSError from "./NATSError.ts"
import type * as NATSOptions from "./NATSOptions.ts"

const factoryError = (cause: unknown) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
  })
/**
 * Normalize NATS and HTTP endpoints for WebSockets. Bare endpoints default
 * to encrypted WebSockets, matching the official v3.4 client.
 * @since 1.0.0
 */
export const normalizeServer = (input: string, encrypted?: boolean): string => {
  const url = new URL(input.includes("://") ? input : `${encrypted === false ? "http" : "https"}://${input}`)
  const secure = ["wss:", "https:", "tls:"].includes(url.protocol)
  if (!["ws:", "wss:", "http:", "https:", "nats:", "tls:"].includes(url.protocol)) {
    throw new Error("Unsupported WebSocket endpoint scheme")
  }
  let host = url.hostname
  if (host.startsWith("[")) {
    const halves = host.slice(1, -1).split("::")
    const left = halves[0] === "" ? [] : halves[0].split(":")
    const right = halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":")
    const groups = halves.length === 1
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    host = "[" + groups.map((group) => Number.parseInt(group, 16).toString(16)).join(":") + "]"
  }
  return `${secure ? "wss" : "ws"}://${host}:${url.port || (secure ? 443 : 80)}${url.pathname || "/"}${url.search}`
}
/** @since 1.0.0 */
export const makeSocket = Effect.fnUntraced(function*(
  endpoint: URL,
  options: NATSOptions.WsConnectionOptions = {}
) {
  if (options.wsFactory !== undefined) {
    const factory = options.wsFactory
    const acquire = Effect.suspend(() => {
      let interrupted = false
      return Effect.gen(function*() {
        const transport = yield* Effect.suspend(() => {
          try {
            const created = factory(endpoint.toString(), options)
            if (Effect.isEffect(created)) return created
            // Attach cleanup in the same synchronous step as invocation: the
            // fiber can be interrupted before its next Promise await begins.
            const result = Promise.resolve(created).then((transport) => {
              if (interrupted) transport.socket.close(1000)
              return transport
            })
            return Effect.tryPromise({
              try: () => result,
              catch: factoryError
            })
          } catch (cause) {
            return Effect.fail(factoryError(cause))
          }
        })
        if (options.tls !== undefined && options.tls !== false && !transport.encrypted) {
          transport.socket.close(1000)
          return yield* Effect.fail(
            factoryError(new Error("WebSocket factory did not establish an encrypted transport"))
          )
        }
        return transport.socket
      }).pipe(Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true
        })
      ))
    })
    return yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        acquire,
        (socket) => Effect.sync(() => socket.close(1000)),
        { interruptible: true }
      ),
      {
        openTimeout: options.timeout ?? 20000,
        ...(options.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark })
      }
    )
  }
  if (options.tls !== undefined && options.tls !== false) {
    return yield* Effect.fail(factoryError(new Error("TLS options are not configurable on a standard WebSocket")))
  }
  return yield* Socket.makeWebSocket(endpoint.toString(), {
    openTimeout: options.timeout ?? 20000,
    ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
    ...(options.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark })
  }).pipe(Effect.provide(
    options.webSocketConstructor === undefined
      ? Socket.layerWebSocketConstructorGlobal
      : Layer.succeed(Socket.WebSocketConstructor)(options.webSocketConstructor)
  ))
})
/** @since 1.0.0 */
export const make = Effect.fnUntraced(function*(options: NATSOptions.WsConnectionOptions = {}) {
  const servers = yield* Effect.try({
    try: () => {
      const input = options.servers ?? "ws://localhost:9222"
      return (typeof input === "string" ? [input] : input).map((server) => normalizeServer(server))
    },
    catch: (cause) =>
      new NATSError.NATSConnectionError({ reason: "Invalid WebSocket endpoint", code: "invalid_argument", cause })
  })
  return yield* Client.make((server) => makeSocket(new URL(server), options), {
    ...options,
    servers
  })
})
/** @since 1.0.0 */
export const layer = (options: NATSOptions.WsConnectionOptions = {}) => Layer.effect(Services.Connection, make(options))
