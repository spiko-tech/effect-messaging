import type * as nats_core from "@nats-io/nats-core"
import * as nats_node from "@nats-io/transport-node"
import * as Effect from "effect/Effect"
import * as NATSError from "../NATSError.js"

/** @internal */
export const connectNode = (
  options?: nats_core.ConnectionOptions
): Effect.Effect<nats_node.NatsConnection, NATSError.NATSConnectionError, never> =>
  Effect.tryPromise({
    try: () => nats_node.connect(options),
    catch: (error) => new NATSError.NATSConnectionError({ reason: "Failed to connect", cause: error })
  })

/** @internal */
export const close = (connection: nats_core.NatsConnection): Effect.Effect<void, never, never> =>
  Effect.tryPromise(() => connection.close()).pipe(Effect.orDie)

/** @internal */
export const info = (connection: nats_core.NatsConnection): nats_core.ServerInfo | undefined => connection.info

/** @internal */
type NatsConnectionMethod =
  | "closed"
  | "close"
  | "publish"
  | "publishMessage"
  | "respondMessage"
  | "subscribe"
  | "request"
  | "requestMany"
  | "flush"
  | "drain"
  | "isClosed"
  | "isDraining"
  | "getServer"
  | "status"
  | "stats"
  | "rtt"
  | "reconnect"

/** @internal */
const wrapConnectionMethod = <K extends NatsConnectionMethod>(
  connection: nats_core.NatsConnection,
  method: K
) =>
(
  ...params: Parameters<nats_core.NatsConnection[K]>
) =>
  Effect.tryPromise({
    try: async () => {
      const toto: nats_core.NatsConnection[K] = connection[method]
      return await toto(...params)
    },
    catch: (error) => new NATSError.NATSConnectionError({ reason: `Failed to call ${method}`, cause: error })
  })

/** @internal */
export const publish = (connection: nats_core.NatsConnection) =>
(
  ...params: Parameters<nats_core.NatsConnection["publish"]>
): Effect.Effect<ReturnType<nats_core.NatsConnection["publish"]>, NATSError.NATSConnectionError> =>
  Effect.tryPromise({
    try: async () => connection.publish(...params),
    catch: (error) => new NATSError.NATSConnectionError({ reason: "Failed to publish", cause: error })
  })
