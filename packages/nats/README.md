# `@effect-messaging/nats`

An Effect-native NATS and JetStream client. The runtime uses Effect 4.0.2 and
`@effect-messaging/core`. It has no dependency on the official NATS clients.
The Node adapter additionally uses `@effect/platform-node` 4.0.2; WebSocket
applications can supply their own socket transport without that adapter.

```ts
import { NATSConnection, NATSNodeConnection } from "@effect-messaging/nats"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const connection = yield* NATSConnection.NATSConnection
  const subscription = yield* connection.subscribe("example.events", { max: 1 })
  yield* connection.publish("example.events", "hello")
  return yield* subscription.stream.pipe(
    Stream.mapEffect((message) => message.string),
    Stream.runCollect
  )
}).pipe(Effect.provide(NATSNodeConnection.layer({ servers: "localhost:4222" })))
```

Connections belong to the layer's scope. Scope closure drains the connection
with a bounded timeout and then closes it. Ending a subscription stream early
unsubscribes it. Pull and push JetStream consumer operations require a scope;
their listeners, watchdogs and recovery fibers end with that scope.

`NATSConnection.make(socketFactory, options)` separates the NATS protocol from
the transport. The factory returns a fresh `effect/socket/Socket` for each
physical connection, including reconnects. `NATSNodeConnection` handles TCP,
INFO-first TLS, handshake-first TLS, certificate verification and mutual TLS.
`NATSWebSocketConnection` supports platform WebSockets and injected factories.

The core API supports publishing, subscriptions and queue groups, headers,
requests and multiple-response streams, status streams, server discovery,
reconnection, flush barriers, statistics and draining. `NATSAuth` supplies
token, user/password, NKey, JWT and credentials-file authenticators.

JetStream modules provide stream and consumer management, publish expectations
and deduplication, stored and direct reads, atomic batches, fast ingest,
scheduled messages and pull, push and ordered consumers. `JetStreamTypes`
contains the owned configuration and wire API types. Wire responses are
validated with Effect Schema; queues, scopes, schedules and typed errors own
the lifecycle and failure behavior.

For an existing stream and durable consumer, keep acquisition and consumption
inside the same scope:

```ts
import { JetStreamClient, NATSNodeConnection } from "@effect-messaging/nats"
import { Effect, Stream } from "effect"

const consume = Effect.scoped(Effect.gen(function*() {
  const connection = yield* NATSNodeConnection.make({ servers: "localhost:4222" })
  const client = JetStreamClient.make(connection)
  const consumer = yield* client.consumers.get("ORDERS", "worker")
  const messages = yield* consumer.consume({ max_messages: 100 })
  yield* messages.stream.pipe(Stream.runForEach((message) => message.ack))
}))
```

The default outbound budget is 8 MiB and 65,536 commands. Configure
`maxBufferedBytes` and `maxPendingCommands` to change it. The default connected
writer waits for capacity; explicit limits and disconnected writes fail with a
typed error when their budget is exhausted. Subscription
`maxPendingMessages` and `maxPendingBytes` provide explicit admission limits;
the byte charge includes headers, subject, reply and payload. Overflow closes
the affected subscription with a typed error. The inbound parser's 64 MiB
payload guard is independent of the outbound budget. The socket reader never
waits for a user's callback to complete.

JetStream consumers use bounded delivery queues. While a queue is full, the
consumer pauses its heartbeat watchdog until application demand resumes.
Ordered recovery resumes after the last message safely retained for delivery,
including when reconnection interrupts a blocked admission.

This rewrite removes underlying `.nc`, `.sub`, `.msg` and official-client
iterator escape hatches. Optional messages, replies, errors and server
information use Effect `Option`. Import option types from `NATSOptions` and
JetStream configuration types from `JetStreamTypes`. Message `.decode(schema)`
validates JSON with Schema, while `.json()` preserves the convenience API.

The compatibility reference is nats.js **3.4.0**. See [PARITY.md](PARITY.md) for
the upstream inventory, case-by-case audit and verified behavior.
Official clients are development-only interoperability references.

Run `pnpm build` and `pnpm lint`, then `pnpm test run packages/nats/test`.
The ordinary integration suites require a JetStream-enabled NATS broker at
`localhost:4222`. Isolated transport and recovery suites require Docker and
run `nats:2.15.0-alpine` with scoped cleanup. Broker tests fail when their
infrastructure is unavailable and are never silently skipped.
