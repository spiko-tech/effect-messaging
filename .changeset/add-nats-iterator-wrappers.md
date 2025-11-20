---
"@effect-messaging/nats": minor
---

Add NATSQueuedIterator and JetStreamLister wrapper modules to provide Effect-style operations for NATS iterators. Updated JetStreamStreamAPI, JetStreamDirectStreamAPI, and JetStreamConsumerAPI to return wrapped iterator types instead of Effect Streams, giving users more control over iteration and allowing access to iterator methods like getProcessed(), getPending(), and next().
