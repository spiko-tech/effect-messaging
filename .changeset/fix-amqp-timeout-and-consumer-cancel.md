---
"@effect-messaging/amqp": patch
---

Make AMQPSubscriber handlers always uninterruptible, fix `handlerTimeout`, and explicitly cancel AMQP consumers on scope finalization.

- Remove the `uninterruptible` option from `AMQPSubscriberOptions`. Handlers are now always uninterruptible, ensuring in-flight message processing completes even when the subscription fiber is interrupted (e.g. SIGINT).
- Fix `handlerTimeout` not working: the timeout previously couldn't fire because `Effect.uninterruptible` prevented the internal interrupt. Fixed by wrapping the handler in `Effect.interruptible` before `timeoutFail`, allowing the timeout to interrupt while the outer `Effect.uninterruptible` still blocks external interrupts.
- Capture the `consumerTag` from `channel.consume()` and register a scope finalizer to call `channel.cancel(consumerTag)`, ensuring explicit consumer cancellation during graceful shutdown instead of relying solely on channel close.
