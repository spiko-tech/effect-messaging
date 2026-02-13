---
"@effect-messaging/nats": patch
"@effect-messaging/amqp": patch
---

fix: revert `matchCauseEffect` to `tapErrorCause` in subscriber implementations to preserve the error channel. `matchCauseEffect` was incorrectly absorbing handler failures into the success channel, silently swallowing errors instead of propagating them.
