---
"@effect-messaging/nats": patch
---

Make JetStreamSubscriber and NATSSubscriber handlers always uninterruptible, and fix `handlerTimeout`.

- Remove the `uninterruptible` option from `JetStreamSubscriberOptions` and `NATSSubscriberOptions`. Handlers are now always uninterruptible, ensuring in-flight message processing completes even when the subscription fiber is interrupted (e.g. SIGINT).
- Fix `handlerTimeout` not working: the timeout previously couldn't fire because `Effect.uninterruptible` prevented the internal interrupt. Fixed by wrapping the handler in `Effect.interruptible` before `timeoutFail`, allowing the timeout to interrupt while the outer `Effect.uninterruptible` still blocks external interrupts.
