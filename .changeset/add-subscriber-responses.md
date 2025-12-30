---
"@effect-messaging/core": patch
"@effect-messaging/amqp": minor
"@effect-messaging/nats": minor
---

Add subscriber response types for explicit message acknowledgment control

- Added response type parameter to Subscriber interface in core
- Added AMQPSubscriberResponse module with Ack, Nack, and Reject response types
- Added JetStreamSubscriberResponse module with Ack, Nak, and Term response types
- Subscribers now return a response to control message acknowledgment behavior
- On handler error, messages are still nacked/rejected automatically
