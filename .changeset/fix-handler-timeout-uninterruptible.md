---
"@effect-messaging/amqp": patch
---

Fix `handlerTimeout` not working when `uninterruptible: true` is set on AMQPSubscriber. `Effect.timeoutFail` relies on interruption internally, which does not work inside `Effect.uninterruptible`. The fix uses a Fiber-based race instead: the app is forked in an interruptible region so the timeout can interrupt it.
