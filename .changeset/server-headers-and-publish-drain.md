---
"@effect-messaging/amqp": patch
"@effect-messaging/nats": patch
---

Drop server-owned NATS headers before publish, and wait for the AMQP write buffer to drain when a non-confirm publish reports the buffer is full.
