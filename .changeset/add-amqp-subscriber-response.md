---
"@effect-messaging/amqp": minor
---

Add AMQPSubscriberResponse module to represent subscriber responses (ack, nack, reject)

- Added new AMQPSubscriberResponse module with Ack, Nack, and Reject response types
- Updated AMQPSubscriber to use AMQPSubscriberResponse instead of void
- Subscribers now return a response to control message acknowledgement behavior
- nack() accepts options for allUpTo (default: false) and requeue (default: true)
- reject() accepts options for requeue (default: true)
- On handler error, messages are still nacked with requeue: false
