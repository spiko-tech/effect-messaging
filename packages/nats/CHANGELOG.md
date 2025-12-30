# @effect-messaging/nats

## 0.7.0

### Minor Changes

- [#115](https://github.com/spiko-tech/effect-messaging/pull/115) [`2b26c0d`](https://github.com/spiko-tech/effect-messaging/commit/2b26c0d3a217616bed3d8a9d7eb03eba47f17646) Thanks [@wewelll](https://github.com/wewelll)! - Add subscriber response types for explicit message acknowledgment control

  - Added response type parameter to Subscriber interface in core
  - Added AMQPSubscriberResponse module with Ack, Nack, and Reject response types
  - Added JetStreamSubscriberResponse module with Ack, Nak, and Term response types
  - Subscribers now return a response to control message acknowledgment behavior
  - On handler error, messages are still nacked/rejected automatically

### Patch Changes

- Updated dependencies [[`2b26c0d`](https://github.com/spiko-tech/effect-messaging/commit/2b26c0d3a217616bed3d8a9d7eb03eba47f17646)]:
  - @effect-messaging/core@0.2.39

## 0.6.1

### Patch Changes

- [#113](https://github.com/spiko-tech/effect-messaging/pull/113) [`5f72eba`](https://github.com/spiko-tech/effect-messaging/commit/5f72ebafae4ac683c42a0798588108a0758e6de8) Thanks [@wewelll](https://github.com/wewelll)! - upgrade effect libraries to their latest version

- Updated dependencies [[`5f72eba`](https://github.com/spiko-tech/effect-messaging/commit/5f72ebafae4ac683c42a0798588108a0758e6de8)]:
  - @effect-messaging/core@0.2.38

## 0.6.0

### Minor Changes

- [#111](https://github.com/spiko-tech/effect-messaging/pull/111) [`e6dd444`](https://github.com/spiko-tech/effect-messaging/commit/e6dd444917557dfbc75c71f0afbacf11176be70e) Thanks [@wewelll](https://github.com/wewelll)! - Add NATSPublisher and NATSSubscriber for NATS Core (without JetStream)

  - `NATSPublisher`: Implements the `Publisher` interface from `@effect-messaging/core` using NATS Core publish (fire-and-forget)
  - `NATSSubscriber`: Implements the `Subscriber` interface from `@effect-messaging/core` using NATS Core subscriptions
  - Both include OpenTelemetry tracing with distributed trace context propagation via headers
  - `NATSSubscriber` supports `uninterruptible` and `handlerTimeout` options
  - Note: NATS Core has no persistence - messages published before subscription starts are lost

## 0.5.2

### Patch Changes

- [#108](https://github.com/spiko-tech/effect-messaging/pull/108) [`1bd9628`](https://github.com/spiko-tech/effect-messaging/commit/1bd96288a17e658d91141329ec519b6b7e4080f1) Thanks [@wewelll](https://github.com/wewelll)! - Upgrade @nats-io/jetstream, @nats-io/nats-core, and @nats-io/transport-node to 3.3.0

## 0.5.1

### Patch Changes

- [#105](https://github.com/spiko-tech/effect-messaging/pull/105) [`90904f8`](https://github.com/spiko-tech/effect-messaging/commit/90904f8ed54119393663b69814f0d1804f70eed2) Thanks [@wewelll](https://github.com/wewelll)! - Upgrade effect to 3.19.12, @effect/platform to 0.93.8, and @effect/language-service to 0.62.3

- Updated dependencies [[`90904f8`](https://github.com/spiko-tech/effect-messaging/commit/90904f8ed54119393663b69814f0d1804f70eed2)]:
  - @effect-messaging/core@0.2.37

## 0.5.0

### Minor Changes

- [#56](https://github.com/spiko-tech/effect-messaging/pull/56) [`5c29732`](https://github.com/spiko-tech/effect-messaging/commit/5c297323e855cd59076f1f5b56ab065731f0a183) Thanks [@wewelll](https://github.com/wewelll)! - Add JetStreamPublisher and JetStreamSubscriber that implement the core Publisher and Subscriber interfaces with OpenTelemetry tracing support. The publisher injects trace context into NATS message headers, and the subscriber extracts it to create parent-child span relationships. The subscriber automatically handles message acknowledgment (ack on success, nak on error) and provides the message to handlers via the JetStreamConsumeMessage context tag.

- [#56](https://github.com/spiko-tech/effect-messaging/pull/56) [`d7fede9`](https://github.com/spiko-tech/effect-messaging/commit/d7fede91b6331da7205e3c72e60981bd4b0432ba) Thanks [@wewelll](https://github.com/wewelll)! - Add NATSQueuedIterator and JetStreamLister wrapper modules to provide Effect-style operations for NATS iterators. Updated JetStreamStreamAPI, JetStreamDirectStreamAPI, and JetStreamConsumerAPI to return wrapped iterator types instead of Effect Streams, giving users more control over iteration and allowing access to iterator methods like getProcessed(), getPending(), and next().

### Patch Changes

- [#56](https://github.com/spiko-tech/effect-messaging/pull/56) [`4f2589a`](https://github.com/spiko-tech/effect-messaging/commit/4f2589a0044a6e19b46acdbc0f1f399a05ab9b18) Thanks [@wewelll](https://github.com/wewelll)! - add monitoring and operation methods to NATSConnection (flush, requestMany, getServer, status, stats, rtt)
