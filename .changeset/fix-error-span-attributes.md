---
"@effect-messaging/amqp": patch
"@effect-messaging/nats": patch
---

Fix error span attributes for Datadog error tracking

- Changed `tag` to `_tag` property check to correctly extract error type from Effect's TaggedError
- Wrapped `Cause.squashWith` calls in `String()` to ensure span attributes are always strings
- This ensures `error.type`, `error.message`, and `error.stack` are properly set for Datadog error tracking
