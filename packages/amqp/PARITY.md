# AMQP 0-9-1 capability evidence

The previous implementation resolved **amqplib 2.2.0** in
[`043f405`'s lockfile](https://github.com/spiko-tech/effect-messaging/blob/043f405853351006cd460448b4be179e15b1f59f/pnpm-lock.yaml).
Parity concerns broker-visible capabilities and semantics, not callbacks or return values.
AMQP 1.0 and the dedicated RabbitMQ Stream Protocol are outside this matrix.

Source/test authorities are pinned to [amqplib 2.2.0][reference],
[RabbitMQ Java 5.37.0][java] and [RabbitMQ .NET 7.2.2][dotnet]. Upstream tests were
inspected, not executed; the native evidence below must pass independently.
Test paths are relative to this package unless indicated otherwise.

Local validation on 2026-10-11 passed 498 repository regression/stress tests with
RabbitMQ 3.13.7. The same 445 AMQP ordinary/stress tests passed on RabbitMQ 4.3.6,
plus seven isolated failure/security/alarm scenarios. Both 100,000-message workloads
retained their assertions and 120-second deadlines; these results are not soak evidence.

Endpoint selection/failover is composed through a fresh Effect socket factory;
`test/AMQPEndpointSelection.test.ts` exercises an unreachable TCP endpoint followed
by a live broker on both initial connection and recovery.

| Capability                                                                                                   | Reference authority                                                                   | Native evidence                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection tuning, heartbeat, closure and secret rotation                                                    | amqplib `test/connection.test.js`, `test/connect.test.js`; .NET `TestUpdateSecret.cs` | `test/AMQPProtocolParity.test.ts`, `AMQPSessionScenarioParity.test.ts`, `AMQPShutdownRecoveryParity.test.ts`                                          |
| Queue/exchange declarations, passive checks, deletion, purge and bindings                                    | amqplib `test/channel_api.test.js`; [queues][queues]                                  | `test/AMQPChannel.test.ts`, `AMQPBrokerScenarioParity.test.ts`                                                                                        |
| Cross-channel declaration dependencies and server-named queue references                                     | Java `impl/recovery/AutorecoveringChannel.java`; [exclusive queues][queues]           | `test/AMQPTopologyOwnership.test.ts`, `desiredTopology.test.ts`                                                                                       |
| Convenience aliases, inherited options/tables and precedence                                                 | amqplib `lib/api_args.js`, `lib/codec.js`                                             | `test/AMQPOptionNormalization.test.ts`, `AMQPOptionBrokerParity.test.ts`                                                                              |
| Per-consumer/global QoS and unlimited zero                                                                   | Java `PerConsumerPrefetch.java`, `QosTests.java`; [prefetch][prefetch]                | `test/AMQPClientReviewRegressions.test.ts`, `AMQPInteropAcknowledgement.test.ts`, `AMQPBrokerExtensionParity.test.ts`                                 |
| Manual ack/nack/reject, multiple settlements and recovery                                                    | Java `Recover.java`, `InvalidAcksTx.java`; [confirms][confirms]                       | `test/deliverySettlement.test.ts`, `AMQPBrokerParity.test.ts`, `AMQPReviewRegressions.test.ts`                                                        |
| Client-requested flow/recovery and broker rejection of unsupported flags                                     | Java `Recover.requeueFalseNotSupported`; [semantics][semantics]                       | `test/AMQPClientReviewRegressions.test.ts`                                                                                                            |
| Genuine consume/get automatic acknowledgement and bounded local buffering                                    | Java `PerConsumerPrefetch.autoAckIgnoresPrefetch`; amqplib `Args.consume/get`         | `test/AMQPAutomaticAcknowledgement.test.ts`, `AMQPInteropAcknowledgement.test.ts`, automatic-ack 100,000-message `AMQPConsumerScenarioParity.test.ts` |
| Direct Reply-To, correlation and at-most-once replies                                                        | Java `DirectReplyTo.java`; [Direct Reply-To][replyto]                                 | `test/AMQPInteropAcknowledgement.test.ts`                                                                                                             |
| Confirm acceptance, negative confirms, returns and uncertain outcomes                                        | Java `Confirm.java`; [confirms][confirms]                                             | `test/AMQPBrokerParity.test.ts`, `AMQPAdmissionReentrancy.test.ts`, `AMQPBrokerQualification.test.ts` (root `test/`)                                  |
| Transactions: select, commit, rollback, settlement rollback and confirm incompatibility                      | Java `Transactions.java`, `Confirm.select`; [semantics][semantics]                    | `test/AMQPTransactions.test.ts`, `AMQPOfficialTransactionParity.test.ts`, `deliverySettlement.test.ts`                                                |
| PLAIN, AMQPLAIN, EXTERNAL and binary/multiple Secure challenges                                              | amqplib `lib/credentials.js`; Java `SaslMechanisms.java`; [access control][acl]       | `test/AMQPAuthentication.test.ts`, root `test/AMQPBrokerQualification.test.ts`                                                                        |
| Field tables, all integer widths, floating-point types, decimals, timestamps, nested arrays and opaque bytes | amqplib `test/codec.test.js`; [field-type errata][errata]                             | `test/AMQPCodec.test.ts`, `protocol.test.ts`, `AMQPWireCompatibility.test.ts`, `AMQPOptionBrokerParity.test.ts`                                       |
| Message properties and independent bidirectional interoperability                                            | amqplib `lib/api_args.js`, `lib/codec.js`                                             | `test/AMQPOptionBrokerParity.test.ts` (pinned amqplib publisher/consumer in both directions)                                                          |
| Alternate exchanges, CC/BCC and internal/exchange-to-exchange routing                                        | amqplib `Args.assertExchange/publish`; [sender-selected routing][sender]              | `test/AMQPOptionBrokerParity.test.ts`, `AMQPBrokerScenarioParity.test.ts`                                                                             |
| TTL, dead lettering, count/byte limits, overflow and queue expiration                                        | amqplib `Args.assertQueue`; [queues][queues]                                          | `test/AMQPOptionBrokerParity.test.ts`, `AMQPInteropAcknowledgement.test.ts`, `AMQPBrokerExtensionParity.test.ts`                                      |
| Message/consumer priority and credit-driven fallback                                                         | Java `ConsumerPriorities.java`, `PriorityQueues.java`                                 | `test/AMQPOptionBrokerParity.test.ts`                                                                                                                 |
| Single-active-consumer promotion and held-delivery redelivery                                                | [consumers][consumers]                                                                | `test/AMQPBrokerExtensionParity.test.ts`                                                                                                              |
| AMQP stream-queue declarations and first/numeric/Date offsets (not Stream Protocol)                          | [streams over AMQP][streams]                                                          | `test/AMQPOptionBrokerParity.test.ts`, `AMQPBrokerExtensionParity.test.ts`                                                                            |
| Incoming channel flow and blocked/unblocked notifications                                                    | Java `ChannelN.processAsync`; [alarms][alarms]                                        | `test/AMQPSessionScenarioParity.test.ts`, root `test/AMQPBrokerQualification.test.ts`                                                                 |
| Connection-wide outbound admission, cancellation and bounded allocation                                      | amqplib backpressure; native bounded-memory contract                                  | `test/AMQPOutboundAdmission.test.ts`, `AMQPClientReviewRegressions.test.ts`, `AMQPAdmissionReentrancy.test.ts`                                        |
| Stale delivery rejection and bounded subscriber execution across recovery                                    | .NET `TestBasicAckAndBasicNack.cs`                                                    | `test/AMQPConsumerFaultParity.test.ts`, `AMQPSubscriberExecution.test.ts`, core `test/SubscriberRunner.test.ts`                                       |
| Real restart durability, quorum leader loss and partitions                                                   | [quorum queues][quorum]                                                               | root `test/AMQPBrokerQualification.test.ts`                                                                                                           |
| Broker-native TLS/mTLS, real ACL/authentication failures, revoked permissions and acknowledgement timeout    | .NET `TestSsl.cs`, `TestAuth.cs`; [TLS][tls], [consumers][consumers]                  | root `test/AMQPBrokerQualification.test.ts`                                                                                                           |
| Actual memory/disk alarms and blocked control progress                                                       | [alarms][alarms]                                                                      | root `test/AMQPBrokerQualification.test.ts`                                                                                                           |

Global QoS behavior is broker-version dependent (official Java global-QoS tests
are limited to RabbitMQ ≤4.2; RabbitMQ 4.3.6 rewrites denied global QoS to
per-consumer QoS). The extension test asserts the version-specific broker behavior,
not just framing. Successful framing or a passing test count alone does not establish
every behavior in a row. See [test setup and guarantees](./README.md).

Remaining qualification gaps: long-running soak/churn, custom authentication-plugin
rotation, non-RabbitMQ brokers and Bun/Deno transports. Inspected upstream suites
are not claimed to have been run in full, nor is every plugin/policy combination covered.

[reference]: https://github.com/amqp-node/amqplib/tree/bcd72ddeed61f5fd336b492621584ebb45154621
[java]: https://github.com/rabbitmq/rabbitmq-java-client/tree/002777578d9138a9921ddfc4f9fb70556f8d4807/src/test/java/com/rabbitmq/client/test
[dotnet]: https://github.com/rabbitmq/rabbitmq-dotnet-client/tree/740faf07f04ade7d35d3539e20613c6ac6b9b46f/projects/Test/Integration
[queues]: https://www.rabbitmq.com/docs/queues
[prefetch]: https://www.rabbitmq.com/docs/consumer-prefetch
[confirms]: https://www.rabbitmq.com/docs/confirms
[replyto]: https://www.rabbitmq.com/docs/direct-reply-to
[semantics]: https://www.rabbitmq.com/docs/semantics
[acl]: https://www.rabbitmq.com/docs/access-control
[errata]: https://www.rabbitmq.com/amqp-0-9-1-errata.html#3-field-types
[sender]: https://www.rabbitmq.com/docs/sender-selected
[streams]: https://www.rabbitmq.com/docs/streams
[alarms]: https://www.rabbitmq.com/docs/alarms
[quorum]: https://www.rabbitmq.com/docs/quorum-queues
[tls]: https://www.rabbitmq.com/docs/ssl
[consumers]: https://www.rabbitmq.com/docs/consumers
