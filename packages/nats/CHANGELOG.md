# @effect-messaging/nats

## 0.5.0

### Minor Changes

- [#56](https://github.com/spiko-tech/effect-messaging/pull/56) [`5c29732`](https://github.com/spiko-tech/effect-messaging/commit/5c297323e855cd59076f1f5b56ab065731f0a183) Thanks [@wewelll](https://github.com/wewelll)! - Add JetStreamPublisher and JetStreamSubscriber that implement the core Publisher and Subscriber interfaces with OpenTelemetry tracing support. The publisher injects trace context into NATS message headers, and the subscriber extracts it to create parent-child span relationships. The subscriber automatically handles message acknowledgment (ack on success, nak on error) and provides the message to handlers via the JetStreamConsumeMessage context tag.

- [#56](https://github.com/spiko-tech/effect-messaging/pull/56) [`d7fede9`](https://github.com/spiko-tech/effect-messaging/commit/d7fede91b6331da7205e3c72e60981bd4b0432ba) Thanks [@wewelll](https://github.com/wewelll)! - Add NATSQueuedIterator and JetStreamLister wrapper modules to provide Effect-style operations for NATS iterators. Updated JetStreamStreamAPI, JetStreamDirectStreamAPI, and JetStreamConsumerAPI to return wrapped iterator types instead of Effect Streams, giving users more control over iteration and allowing access to iterator methods like getProcessed(), getPending(), and next().

### Patch Changes

- [#56](https://github.com/spiko-tech/effect-messaging/pull/56) [`4f2589a`](https://github.com/spiko-tech/effect-messaging/commit/4f2589a0044a6e19b46acdbc0f1f399a05ab9b18) Thanks [@wewelll](https://github.com/wewelll)! - add monitoring and operation methods to NATSConnection (flush, requestMany, getServer, status, stats, rtt)
