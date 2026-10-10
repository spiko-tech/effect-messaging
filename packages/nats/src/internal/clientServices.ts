// Internal connection service keys. Kept in declarations used by the public service facade.
import * as Context from "effect/Context"
import type * as NATSConnection from "../NATSConnection.ts"

export const ConnectionTypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSConnection")
export const Connection: Context.Service<NATSConnection.NATSConnection, NATSConnection.NATSConnection> = Context
  .Service<
    NATSConnection.NATSConnection
  >("@effect-messaging/nats/NATSConnection")
