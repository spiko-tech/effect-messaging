# `@effect-messaging/amqp`

An Effect-native AMQP 0-9-1 client targeting RabbitMQ. Authentication uses PLAIN;
use TLS for remote connections. Transactions, automatic acknowledgements (`noAck`)
and alternate SASL mechanisms are not supported.

## Usage

See the repository [quickstart](../../README.md#amqp-with-effect-messagingamqp).
The package root is runtime-neutral. Node TCP/TLS connections use the explicit
`AMQPNodeConnection` subpath and require the matching `@effect/platform-node` version.
Core publisher/subscriber adapters are also explicit subpaths; `@effect-messaging/core`
is an optional peer. Bun and Deno compatibility must be verified independently.

For API details, see [AMQPConnection](./src/AMQPConnection.ts),
[AMQPChannel](./src/AMQPChannel.ts) and [AMQPTypes](./src/AMQPTypes.ts).

## Migration from amqplib-backed releases

- Move URL/Node transport construction to `AMQPNodeConnection.layer(url, options)`.
- Import core adapters from their subpaths rather than the package root.
- Payloads use `Uint8Array`, delivery tags use `bigint`, publishing returns `Effect<void>`,
  and an empty `get` returns `Option.none()`.
- Use package-owned types instead of amqplib types.
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

## Broker tests

With an available RabbitMQ broker on port 5679:

```sh
pnpm build
pnpm lint
pnpm test run packages/amqp/test
```

For a disposable broker, start `rabbitmq:4.3.6-management` with port 5672 mapped
to local port 5679. Override the test endpoint with `AMQP_TEST_HOST` and `AMQP_TEST_PORT`.
The [CI workflow](../../.github/workflows/check.yml) defines the complete service setup.

Passing tests are not production qualification. Validate real broker restart and
quorum failover, durability, network partitions, soak/churn, ACLs, acknowledgement
timeouts and authentication-plugin rotation for your deployment. TLS tests use a
verified proxy, not broker-native TLS.
