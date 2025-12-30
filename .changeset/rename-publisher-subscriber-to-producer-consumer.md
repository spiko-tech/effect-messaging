---
"@effect-messaging/core": major
"@effect-messaging/amqp": major
"@effect-messaging/nats": major
---

Rename Publisher/Subscriber to Producer/Consumer across all packages for industry-standard naming

### Breaking Changes

**@effect-messaging/core:**
- `Publisher` renamed to `Producer`
- `Subscriber` renamed to `Consumer`
- `PublisherError` renamed to `ProducerError`
- `SubscriberError` renamed to `ConsumerError`
- `SubscriberApp` renamed to `ConsumerApp`
- `Producer.publish()` method renamed to `Producer.send()`
- `Consumer.subscribe()` method renamed to `Consumer.serve()`

**@effect-messaging/amqp:**
- `AMQPPublisher` renamed to `AMQPProducer`
- `AMQPSubscriber` renamed to `AMQPConsumer`
- `AMQPSubscriberResponse` renamed to `AMQPConsumerResponse`
- `AMQPProducer.publish()` method renamed to `AMQPProducer.send()`
- `AMQPConsumer.subscribe()` method renamed to `AMQPConsumer.serve()`

**@effect-messaging/nats:**
- `NATSPublisher` renamed to `NATSProducer`
- `NATSSubscriber` renamed to `NATSConsumer`
- `JetStreamPublisher` renamed to `JetStreamProducer`
- `JetStreamSubscriber` renamed to `JetStreamConsumer`
- `JetStreamSubscriberResponse` renamed to `JetStreamConsumerResponse`
- The previous low-level `JetStreamConsumer` wrapper (for NATS consumers) is now exported as `JetStreamConsumerMessages`
- `NATSProducer.publish()` method renamed to `NATSProducer.send()`
- `JetStreamProducer.publish()` method renamed to `JetStreamProducer.send()`
- `NATSConsumer.subscribe()` method renamed to `NATSConsumer.serve()`
- `JetStreamConsumer.subscribe()` method renamed to `JetStreamConsumer.serve()`

### Migration Guide

Update your imports and code references:

```typescript
// Before
import { Publisher, Subscriber } from "@effect-messaging/core"
import { AMQPPublisher, AMQPSubscriber } from "@effect-messaging/amqp"
import { JetStreamPublisher, JetStreamSubscriber } from "@effect-messaging/nats"

// After
import { Producer, Consumer } from "@effect-messaging/core"
import { AMQPProducer, AMQPConsumer } from "@effect-messaging/amqp"
import { JetStreamProducer, JetStreamConsumer } from "@effect-messaging/nats"
```

Update method calls on producer instances:

```typescript
// Before
yield* producer.publish({ ... })

// After
yield* producer.send({ ... })
```

Update method calls on consumer instances:

```typescript
// Before
yield* consumer.subscribe(messageHandler)

// After
yield* consumer.serve(messageHandler)
```
