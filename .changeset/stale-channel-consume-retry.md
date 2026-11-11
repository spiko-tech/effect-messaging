---
"@effect-messaging/amqp": patch
---

Stop retrying consumer setup (`prefetch`/`consume`) on a channel that has closed. The retry used to loop forever on the dead channel, logging an `AMQPChannelError: Channel closed` every second per queue, while the replacement channel did the real work. The consume stream for a channel now ends as soon as that channel closes or is shut down, and the replacement channel takes over.
