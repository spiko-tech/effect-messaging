# Effect v4 Capability Matrix

This matrix is the parity contract for the `1.0.0` prerelease. A capability may be removed or changed only through an explicit
migration decision. Passing a replacement test is not sufficient when a released module or legacy behavior remains unaccounted.

Status values:

- **Covered**: represented by restored source and migrated regression tests.
- **Source**: represented by restored source but lacking direct regression coverage.
- **Required**: release coverage still needs to be added or verified.

## Core

| Capability                           | Released API                                     | Coverage                            | Status  |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------- | ------- |
| Nominal publishing contract          | `Publisher`, `PublisherError`                    | `Publisher.test.ts`, type contracts | Covered |
| Context-provided subscriber handlers | `Subscriber`, `SubscriberApp`, `SubscriberError` | Broker subscriber suites            | Covered |
| Handler success/error callbacks      | `SubscriberRunner`                               | `SubscriberRunner.test.ts`          | Covered |
| Handler timeout and interruption     | `SubscriberRunner`                               | `SubscriberRunner.test.ts`          | Covered |
| Producer parent/link tracing         | `SubscriberOTel`, `SubscriberRunner`             | `SubscriberRunner.test.ts`          | Covered |

## Core NATS

| Capability                               | Released API                                        | Coverage                           | Status   |
| ---------------------------------------- | --------------------------------------------------- | ---------------------------------- | -------- |
| Scoped connection and server metadata    | `NATSConnection`                                    | `NATSConnection.test.ts`           | Covered  |
| Publish/subscribe                        | `NATSConnection`, `NATSSubscription`, `NATSMessage` | `NATSConnection.test.ts`           | Covered  |
| Ordered multi-message delivery           | `NATSSubscription`, `NATSQueuedIterator`            | `NATSConnection.test.ts`           | Covered  |
| Wildcard subjects                        | `NATSConnection`                                    | `NATSConnection.test.ts`           | Covered  |
| Request/reply                            | `NATSConnection`, `NATSMessage`                     | `NATSConnection.test.ts`           | Covered  |
| Ephemeral subscription behavior          | `NATSSubscriber`                                    | `NATSSubscriber.test.ts`           | Covered  |
| Subscriber failure isolation             | `NATSSubscriber`                                    | `NATSSubscriber.test.ts`           | Covered  |
| Subscriber timeout and interruption      | `NATSSubscriber`                                    | `NATSSubscriber.test.ts`           | Covered  |
| Subscriber health check                  | `NATSSubscriber`                                    | `NATSSubscriber.test.ts`           | Covered  |
| Publishing and tracing                   | `NATSPublisher`, `NATSHeaders`                      | Subscriber suites                  | Covered  |
| Queue groups                             | `NATSConnection`                                    | No direct restored test identified | Required |
| Header and trace-context round trip      | `NATSHeaders`, `NATSMessage`                        | `NATSHeaders.test.ts`              | Covered  |
| Scoped connection drain                  | `NATSConnection`                                    | `NATSConnection.test.ts`           | Covered  |
| Flush semantics                          | `NATSConnection`                                    | `NATSConnection.test.ts`           | Covered  |
| Reconnect and subscription replay        | `NATSConnection`, `NATSSubscriber`                  | No broker-restart test identified  | Required |
| Token, user/password, NKey, and JWT auth | Connection options                                  | No restored auth matrix identified | Required |
| TLS                                      | Connection options                                  | No restored TLS matrix identified  | Required |

## JetStream

| Capability                               | Released API                             | Coverage                           | Status   |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------- | -------- |
| Client acquisition                       | `JetStreamClient`                        | `JetStreamClient.test.ts`          | Covered  |
| Acknowledged publish and fetch           | `JetStreamClient`, `JetStreamPublisher`  | `JetStreamClient.test.ts`          | Covered  |
| JSON payloads                            | `JetStreamClient`, `JetStreamMessage`    | `JetStreamClient.test.ts`          | Covered  |
| Nak redelivery                           | `JetStreamMessage`, `JetStreamConsumer`  | `JetStreamClient.test.ts`          | Covered  |
| Single-message `next`                    | `JetStreamConsumer`                      | `JetStreamClient.test.ts`          | Covered  |
| Continuous consume                       | `JetStreamConsumer`                      | `JetStreamClient.test.ts`          | Covered  |
| Stream creation and publishing           | `JetStreamManager`, `JetStreamStreamAPI` | `JetStreamManager.test.ts`         | Covered  |
| Stream and consumer listing              | `JetStreamLister`, manager APIs          | `JetStreamManager.test.ts`         | Covered  |
| Stream and consumer info                 | Manager APIs                             | `JetStreamManager.test.ts`         | Covered  |
| Stream purge and update                  | `JetStreamStreamAPI`                     | `JetStreamManager.test.ts`         | Covered  |
| Multiple filter subjects                 | `JetStreamConsumerAPI`                   | `JetStreamManager.test.ts`         | Covered  |
| Subscriber delivery                      | `JetStreamSubscriber`                    | `JetStreamSubscriber.test.ts`      | Covered  |
| In-flight interruption and timeout       | `JetStreamSubscriber`                    | `JetStreamSubscriber.test.ts`      | Covered  |
| Failure to nak mapping                   | `JetStreamSubscriber`                    | `JetStreamSubscriber.test.ts`      | Covered  |
| Delayed nak and term outcomes            | `JetStreamSubscriberResponse`            | `JetStreamSubscriber.test.ts`      | Covered  |
| Subscriber health check                  | `JetStreamSubscriber`                    | `JetStreamSubscriber.test.ts`      | Covered  |
| Batch operations                         | `JetStreamBatch`                         | No direct restored test identified | Source   |
| Direct stream access                     | `JetStreamDirectStreamAPI`               | No direct restored test identified | Source   |
| Stored message operations                | `JetStreamStoredMessage`                 | No direct restored test identified | Source   |
| Durable resume after reconnect           | Client and subscriber APIs               | No process-restart test identified | Required |
| Deduplication headers                    | `JetStreamPublisher`                     | No direct restored test identified | Required |
| Pull expiry, heartbeat, and flow control | Consumer APIs                            | No fault-oriented test identified  | Required |

## AMQP

| Capability                                 | Released API                         | Coverage                                   | Status   |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------ | -------- |
| Scoped connection and server properties    | `AMQPConnection`                     | `AMQPConnection.test.ts`                   | Covered  |
| Connection replacement                     | `AMQPConnection`                     | `AMQPConnection.test.ts`                   | Covered  |
| Scoped channel and server properties       | `AMQPChannel`                        | `AMQPChannel.test.ts`                      | Covered  |
| Channel replacement                        | `AMQPChannel`                        | `AMQPChannel.test.ts`                      | Covered  |
| Channel replacement after connection loss  | `AMQPChannel`                        | `AMQPChannel.test.ts`                      | Covered  |
| Queue checks and typed failure             | `AMQPChannel`                        | `AMQPChannel.test.ts`                      | Covered  |
| Recovery across connection/channel failure | `AMQPSubscriber`                     | `AMQPSubscriber.test.ts`                   | Covered  |
| Handler timeout and interruption           | `AMQPSubscriber`                     | `AMQPSubscriber.test.ts`                   | Covered  |
| Consumer cancellation on interruption      | `AMQPSubscriber`                     | `AMQPSubscriber.test.ts`                   | Covered  |
| Nack and reject outcomes                   | `AMQPSubscriberResponse`             | `AMQPSubscriber.test.ts`                   | Covered  |
| Ack outcome                                | `AMQPSubscriberResponse`             | Successful subscriber paths                | Covered  |
| Publishing                                 | `AMQPPublisher`                      | Subscriber fixtures                        | Covered  |
| Exchange declaration/check/delete/bind     | `AMQPChannel`                        | No direct restored test identified         | Source   |
| Queue declaration/delete/purge/bind        | `AMQPChannel`                        | Queue checks only                          | Source   |
| Confirm publishing                         | `AMQPChannel`, `AMQPPublisher`       | No direct confirmation test identified     | Required |
| Writable backpressure/drain                | `AMQPPublisher`                      | No direct restored test identified         | Required |
| Prefetch                                   | `AMQPChannel`, `AMQPSubscriber`      | Exercised indirectly                       | Source   |
| Requeue and redelivery                     | `AMQPSubscriberResponse`             | Nack path does not fully prove redelivery  | Required |
| Secret rotation                            | `AMQPConnection`                     | No direct restored test identified         | Source   |
| Authentication and TLS                     | Connection options                   | No restored matrix identified              | Required |
| Graceful shutdown ordering                 | Connection/channel/subscriber scopes | No explicit resource-order test identified | Required |

## Runtime And Packaging Gates

| Gate                                                     | Beta     | Release candidate |
| -------------------------------------------------------- | -------- | ----------------- |
| Effect 4-only dependency graph                           | Required | Required          |
| Full source, examples, tests, and type contracts compile | Required | Required          |
| Full restored integration suites on Node                 | Required | Required          |
| Full restored integration suites on Bun                  | Target   | Required          |
| Authentication and TLS matrix                            | Target   | Required          |
| Broker restart and network-fault matrix                  | Target   | Required          |
| Build, lint, frozen install, and package dry-runs        | Required | Required          |
| Declaration/API inspection                               | Required | Required          |
| Clean consumer-project smoke tests                       | Required | Required          |

This document records current regression coverage, not a claim that uncovered source is safe. Every **Source** and **Required**
row must become covered or be documented as an intentional incompatibility before the release candidate.
