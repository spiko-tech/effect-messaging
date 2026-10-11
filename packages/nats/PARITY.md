# Native NATS compatibility baseline

The compatibility reference is `nats-io/nats.js` **v3.4.0** (commit `95e76e79d9feaa0a0bf3b0e8da526ec5a3460979`), covering the three packages replaced by this rewrite: `@nats-io/nats-core`, `@nats-io/jetstream` and `@nats-io/transport-node`. KV, object store and services are separate upstream packages.

The runtime imports no official NATS packages. Effect 4.0.2 owns sockets, scopes, streams, bounded queues, interruption, clocks, schedules and typed failures. Effect Schema validates wire responses. TCP/TLS and WebSocket adapters share the protocol and connection state machine; JetStream management, publishing and consumer operations share native API and lifecycle modules.

## Case audit

All **800 statically named inventory entries across 64 upstream test files** are classified: **758 covered cases and 42 explicit exclusions**, with no uncovered entries. The [inventory](test/upstream-v3.4.0-inventory.json) records exact upstream names and source lines. The artifacts below map each case to native assertions and explain adaptations.

The exclusions comprise:

- **39 implementation-specific cases:** 37 tests of removed buffer, IP and private helper representations; one private JetStream status constructor; and one private per-connection feature-disable injection. Native protocol, buffer ownership, schema, lifecycle and capability-routing laws are tested separately. Supplementary assertions do not inflate the covered count.
- **2 Node smoke cases** for the separate KV and object-store packages, which were never dependencies of this package.
- **1 commented-out upstream 409 test**, counted by the static inventory but disabled in the original source after a server behavior change.

The public API uses Effect and intentionally changes Promise, iterator and private cursor representations. Reset tests inject real wire-sequence gaps instead of corrupting private cursor fields. Version gates use advertised server capabilities. Where NATS 2.15.0 changed server policy, configuration tests compare the native client with the official 3.4.0 client on the same broker; the relevant mapping states the difference. These are explicit adaptations, not a claim that every historical private assertion has an identical native representation.

| Case audit                                                            | Covered upstream cases | Explicit exclusions |
| --------------------------------------------------------------------- | ---------------------: | ------------------: |
| [basics](test/upstream-basics-mapping.json)                           |                     88 |                   0 |
| [consumption](test/upstream-consumption-mapping.json)                 |                     47 |                   0 |
| [drain](test/upstream-drain-mapping.json)                             |                     14 |                   0 |
| [facade direct](test/upstream-facade-direct-mapping.json)             |                     33 |                   0 |
| [foundation](test/upstream-foundation-mapping.json)                   |                     34 |                   0 |
| [general jetstream](test/upstream-general-jetstream-mapping.json)     |                     46 |                   0 |
| [internal laws](test/upstream-internal-laws-mapping.json)             |                     29 |                  37 |
| [iterator json](test/upstream-iterator-json-mapping.json)             |                     20 |                   0 |
| [jetstream message](test/upstream-jetstream-message-mapping.json)     |                     11 |                   0 |
| [legacy consumers](test/upstream-legacy-consumers-mapping.json)       |                     44 |                   1 |
| [lifecycle](test/upstream-lifecycle-mapping.json)                     |                     25 |                   0 |
| [management](test/upstream-management-mapping.json)                   |                     99 |                   1 |
| [mrequest](test/upstream-mrequest-mapping.json)                       |                     21 |                   0 |
| [node](test/upstream-node-mapping.json)                               |                     42 |                   2 |
| [ordered push](test/upstream-ordered-push-mapping.json)               |                     45 |                   0 |
| [parser](test/upstream-parser-mapping.json)                           |                     14 |                   0 |
| [pool reconnect](test/upstream-pool-reconnect-mapping.json)           |                     33 |                   0 |
| [publisher schedules](test/upstream-publisher-schedules-mapping.json) |                     29 |                   1 |
| [security transports](test/upstream-security-transports-mapping.json) |                     55 |                   0 |
| [subscription](test/upstream-subscription-mapping.json)               |                     29 |                   0 |

## Upstream test-file inventory

### core

| Upstream test file                                                                                                    | Statically named cases |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------: |
| [core/tests/auth_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/auth_test.ts)                     |                     35 |
| [core/tests/authenticator_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/authenticator_test.ts)   |                      9 |
| [core/tests/autounsub_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/autounsub_test.ts)           |                     11 |
| [core/tests/basics_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/basics_test.ts)                 |                     88 |
| [core/tests/bench_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/bench_test.ts)                   |                      5 |
| [core/tests/binary_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/binary_test.ts)                 |                      5 |
| [core/tests/buffer_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/buffer_test.ts)                 |                     24 |
| [core/tests/clobber_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/clobber_test.ts)               |                      1 |
| [core/tests/databuffer_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/databuffer_test.ts)         |                      4 |
| [core/tests/disconnect_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/disconnect_test.ts)         |                      2 |
| [core/tests/dispose_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/dispose_test.ts)               |                     10 |
| [core/tests/doublesubs_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/doublesubs_test.ts)         |                      2 |
| [core/tests/drain_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/drain_test.ts)                   |                     14 |
| [core/tests/encoders_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/encoders_test.ts)             |                      1 |
| [core/tests/events_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/events_test.ts)                 |                      7 |
| [core/tests/headers_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/headers_test.ts)               |                     25 |
| [core/tests/heartbeats_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/heartbeats_test.ts)         |                      3 |
| [core/tests/idleheartbeats_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/idleheartbeats_test.ts) |                      7 |
| [core/tests/iterators_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/iterators_test.ts)           |                     10 |
| [core/tests/json_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/json_test.ts)                     |                     10 |
| [core/tests/launcher_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/launcher_test.ts)             |                      1 |
| [core/tests/mrequest_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/mrequest_test.ts)             |                     21 |
| [core/tests/parseip_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/parseip_test.ts)               |                      4 |
| [core/tests/parser_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/parser_test.ts)                 |                     14 |
| [core/tests/properties_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/properties_test.ts)         |                      9 |
| [core/tests/protocol_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/protocol_test.ts)             |                      5 |
| [core/tests/queues_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/queues_test.ts)                 |                      3 |
| [core/tests/reconnect_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/reconnect_test.ts)           |                     20 |
| [core/tests/resub_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/resub_test.ts)                   |                      3 |
| [core/tests/semver_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/semver_test.ts)                 |                      3 |
| [core/tests/servers_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/servers_test.ts)               |                     10 |
| [core/tests/timeout_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/timeout_test.ts)               |                      2 |
| [core/tests/tls_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/tls_test.ts)                       |                      5 |
| [core/tests/token_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/token_test.ts)                   |                      3 |
| [core/tests/types_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/types_test.ts)                   |                      3 |
| [core/tests/util_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/util_test.ts)                     |                      8 |
| [core/tests/ws_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/core/tests/ws_test.ts)                         |                     12 |

Total: **37 files**, **399 statically named cases**.

### jetstream

| Upstream test file                                                                                                                              | Statically named cases |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------: |
| [jetstream/tests/batch_publisher_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/batch_publisher_test.ts)               |                      5 |
| [jetstream/tests/consume_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/consume_test.ts)                               |                     18 |
| [jetstream/tests/consumer_reset_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/consumer_reset_test.ts)                 |                      7 |
| [jetstream/tests/consumers_ordered_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/consumers_ordered_test.ts)           |                     40 |
| [jetstream/tests/consumers_push_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/consumers_push_test.ts)                 |                      5 |
| [jetstream/tests/consumers_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/consumers_test.ts)                           |                     15 |
| [jetstream/tests/direct_consumer_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/direct_consumer_test.ts)               |                      3 |
| [jetstream/tests/fast_ingest_publisher_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/fast_ingest_publisher_test.ts)   |                     13 |
| [jetstream/tests/fetch_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/fetch_test.ts)                                   |                     12 |
| [jetstream/tests/jetstream409_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jetstream409_test.ts)                     |                      4 |
| [jetstream/tests/jetstream_pullconsumer_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jetstream_pullconsumer_test.ts) |                      7 |
| [jetstream/tests/jetstream_pushconsumer_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jetstream_pushconsumer_test.ts) |                     23 |
| [jetstream/tests/jetstream_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jetstream_test.ts)                           |                     46 |
| [jetstream/tests/jscluster_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jscluster_test.ts)                           |                      3 |
| [jetstream/tests/jsm_direct_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jsm_direct_test.ts)                         |                      9 |
| [jetstream/tests/jsm_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jsm_test.ts)                                       |                    100 |
| [jetstream/tests/jsmsg_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/jsmsg_test.ts)                                   |                     11 |
| [jetstream/tests/next_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/next_test.ts)                                     |                     10 |
| [jetstream/tests/pushconsumers_ordered_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/pushconsumers_ordered_test.ts)   |                      8 |
| [jetstream/tests/schedules_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/schedules_test.ts)                           |                     10 |
| [jetstream/tests/status_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/status_test.ts)                                 |                      2 |
| [jetstream/tests/streams_test.ts](https://github.com/nats-io/nats.js/blob/v3.4.0/jetstream/tests/streams_test.ts)                               |                      6 |

Total: **22 files**, **357 statically named cases**.

### transport-node

| Upstream test file                                                                                                              | Statically named cases |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------: |
| [transport-node/tests/basics_test.js](https://github.com/nats-io/nats.js/blob/v3.4.0/transport-node/tests/basics_test.js)       |                     14 |
| [transport-node/tests/jetstream_test.js](https://github.com/nats-io/nats.js/blob/v3.4.0/transport-node/tests/jetstream_test.js) |                      4 |
| [transport-node/tests/noiptls_test.js](https://github.com/nats-io/nats.js/blob/v3.4.0/transport-node/tests/noiptls_test.js)     |                      1 |
| [transport-node/tests/reconnect_test.js](https://github.com/nats-io/nats.js/blob/v3.4.0/transport-node/tests/reconnect_test.js) |                      8 |
| [transport-node/tests/tls_test.js](https://github.com/nats-io/nats.js/blob/v3.4.0/transport-node/tests/tls_test.js)             |                     17 |

Total: **5 files**, **44 statically named cases**.

## Verification

The PR branch based on `main` passed **1,132 tests across 53 files**, including **1,084 NATS tests across 46 files**. Coverage for `packages/nats/src` alone, excluding fixtures and other packages, is:

| Metric     | Coverage | Executed / total |
| ---------- | -------: | ---------------: |
| Statements |   93.36% |    2,643 / 2,831 |
| Branches   |   90.28% |    1,877 / 2,079 |
| Functions  |   87.32% |        675 / 773 |
| Lines      |   94.97% |    2,400 / 2,527 |

The suites exercise core messaging, binary framing and fragmentation, headers, queue groups, requests, permission changes, authentication, verified TLS, mutual TLS, WebSockets, server discovery, reconnect limits, subscription replay, drains, shutdown and buffer ownership. The full clobber workload retains and verifies 256,000 messages of 1,024 bytes each.

JetStream coverage includes CRUD and large paginated listings, cross-account and domain APIs, tiered limits, retention and replication, publish expectations and deduplication, atomic batches, fast ingest, scheduled messages, stored and direct reads, acknowledgements, pull/push and ordered recovery, heartbeat and flow control, byte/message budgets, pinned demand and unpinning, source/mirror placement and actual cluster leader loss. Slow callbacks and iterators exercise protocol controls and bounded delivery. When application demand fills a consumer queue, its heartbeat watchdog pauses until admission resumes; ordered recovery commits its cursor only after safe retention.

Type tests verify native error channels, owned acknowledgement types and Scope requirements on TypeScript 5.9.3 and 6.0.3. Release checks build declarations, load all packed public entry points in an isolated installation, reject internal exports and detect circular dependencies.

Integration fixtures use **NATS 2.15.0**. Older feature gates are tested with controlled advertised capabilities; this does not constitute an integration matrix for every historical broker release. Code coverage measures executed branches and lines, independently of the upstream case audit.

## Running the suites

Run `pnpm build` and `pnpm lint` before tests, then `pnpm coverage run --maxWorkers=4` for the full repository or `pnpm test run packages/nats/test` for NATS. The ordinary integration suites require a real JetStream-enabled broker at `localhost:4222`. Isolated broker suites use Docker and pinned `nats:2.15.0-alpine`, event-based readiness and scoped container cleanup. Missing infrastructure causes a failure; broker tests are never silently skipped. Official NATS clients are development-only interoperability oracles.

`pnpm --filter @effect-messaging/nats check-parity --require-complete` validates inventory references, source lines, native case labels, evidence explanations and total classification. CI runs this check. It checks evidence links; it does not substitute for running or reviewing the assertions.
