# `@effect-messaging/amqp`

An Effect-native AMQP 0-9-1 client targeting RabbitMQ. Supports confirms,
transactions, manual/automatic acknowledgement, Direct Reply-To and
PLAIN/AMQPLAIN/EXTERNAL or custom SASL authentication. Use TLS for remote connections.
See the source-backed [capability matrix](./PARITY.md) for verification evidence.

## Usage

See the repository [quickstart](../../README.md#amqp-with-effect-messagingamqp).
The package root is runtime-neutral. Node TCP/TLS connections use the explicit
`AMQPNodeConnection` subpath and require the matching `@effect/platform-node` version.
Core publisher/subscriber adapters are also explicit subpaths; `@effect-messaging/core`
is an optional peer. Bun and Deno compatibility must be verified independently.
For endpoint failover, compose selection into `AMQPConnection.SocketFactory`: it
is evaluated afresh on each connection/recovery attempt and must create a fresh socket.

For API details, see [AMQPConnection](./src/AMQPConnection.ts),
[AMQPChannel](./src/AMQPChannel.ts) and [AMQPTypes](./src/AMQPTypes.ts).

## Migration from amqplib-backed releases

- Move URL/Node transport construction to `AMQPNodeConnection.layer(url, options)`.
- Import core adapters from their subpaths rather than the package root.
- Payloads use `Uint8Array`, delivery tags use `bigint`, publishing returns `Effect<void>`,
  and an empty `get` returns `Option.none()`.
- Use package-owned types instead of amqplib types.
- Queue/exchange convenience arguments, consumer priority and publish CC/BCC retain
  amqplib precedence over raw arguments/headers. Inputs are snapshotted, not mutated.
- Explicit integer widths use `AMQPTypes.fieldInteger`; full-range table timestamps
  use `fieldTimestamp`. These and float/decimal wrappers preserve wire types on republish.
- Retain the reference returned by `assertQueue`, not its `.queue` name snapshot,
  so server-named queues remain usable after recovery.

## Delivery guarantees

- Recovery restores declarations and consumers, not publishes or past commands.
  Authentication and topology failures can be terminal.
- Publishing defaults to transport-write completion. Enable `confirm: true` for broker
  acceptance; confirmation alone does not establish routing, persistence or consumption.
  Use `mandatory` with `channel.returns` to detect unroutable messages, and durable
  queues with persistent messages for restart durability.
- An `AMQPPublishError` with outcome `Unknown` may already have reached the broker and
  is never silently retried. Use an outbox and/or idempotent processing to avoid
  duplicate side effects from retries and redelivery.
- Old deliveries cannot be settled after session replacement. Broker consumer
  cancellation fails the stream visibly. Shutdown deadlines cannot bound arbitrarily
  uninterruptible application handlers.
- `prefetch: 0` means unlimited **broker** credit. Local message/byte limits still
  apply; overflow is a visible consumer failure, not silent dropping. Consumer QoS
  and its mailbox are resolved together and remain fixed across recovery.
- `noAck` is broker automatic acknowledgement, not acknowledgement after a handler.
  Such deliveries cannot be settled or recovered; cancellation/overflow can lose
  already-received messages. Direct Reply-To requires `noAck` and the same channel
  for requests and replies.
- Transactions are incompatible with confirms. Commit/rollback wait for broker
  replies; an unknown transaction outcome is never replayed. Recovery restores
  transaction mode, not uncommitted messages or settlements.
- `flow(false)` and `recover(false)` are transmitted rather than emulated; RabbitMQ
  rejects them with typed `540 NOT_IMPLEMENTED` diagnostics. Global QoS support
  depends on the broker version; per-consumer QoS is the portable default.
- RabbitMQ 4.3 disables transient, non-exclusive queues by default. Use durable
  shared queues or exclusive temporary queues unless your broker explicitly permits them.

## Broker tests

With an available RabbitMQ broker on port 5679:

```sh
pnpm build
pnpm lint
pnpm test run --exclude '**/AMQPConsumerScenarioParity.test.ts' --exclude '**/AMQPBrokerParity.test.ts'
pnpm test run packages/amqp/test/AMQPConsumerScenarioParity.test.ts
pnpm test run packages/amqp/test/AMQPBrokerParity.test.ts
pnpm test run --config test/fixtures/review-broker/vitest.config.ts
```

For a disposable broker, start `rabbitmq:4.3.6-management` with port 5672 mapped
to local port 5679 and management port 15672 to 15679. Override the test endpoint
with `AMQP_TEST_HOST`, `AMQP_TEST_PORT` and `AMQP_TEST_MANAGEMENT_PORT`. The ordinary
suite also needs the repository's NATS service. Run shared-broker stress workloads
sequentially; the 100,000-message deadline is 120 seconds.

The qualification suite requires Docker and OpenSSL, creates owned disposable
brokers/networks/certificates and fails if prerequisites are missing. It never
stops the shared brokers. The [CI workflow](../../.github/workflows/check.yml)
runs it in a separate job.

These are bounded scenarios, not a soak/churn or deployment-readiness guarantee.
Qualify your broker version, policies, storage and authentication configuration
before production use; redelivery and uncertain outcomes still require idempotency.
