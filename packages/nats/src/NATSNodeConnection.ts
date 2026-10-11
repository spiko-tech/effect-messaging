/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Socket from "effect/socket/Socket"
import * as Client from "./internal/client.ts"
import * as Services from "./internal/clientServices.ts"
import type * as NATSOptions from "./NATSOptions.ts"

/** @since 0.1.0 */
export const makeSocket = Effect.fnUntraced(function*(
  endpoint: URL,
  options: NATSOptions.NodeConnectionOptions = {},
  tlsName?: string
) {
  const adapter = yield* Effect.tryPromise({
    try: () => import("./internal/nodeSocket.ts"),
    catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })
  })
  return yield* adapter.makeSocket(endpoint, options, tlsName)
})
/** @since 0.1.0 */
export const make = (options: NATSOptions.NodeConnectionOptions = {}) =>
  Client.make((server, metadata) => makeSocket(new URL(server), options, metadata.tlsName), options)
/** @since 0.1.0 */
export const layer = (options: NATSOptions.NodeConnectionOptions = {}) =>
  Layer.effect(Services.Connection, make(options))
