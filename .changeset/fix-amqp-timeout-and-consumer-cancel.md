---
"@effect-messaging/amqp": patch
---

Fix `handlerTimeout` not working with `uninterruptible: true` in AMQPSubscriber, and explicitly cancel AMQP consumers on scope finalization.

- When both `uninterruptible: true` and `handlerTimeout` were configured, the timeout never actually stopped the handler because `Effect.uninterruptible` prevented `timeoutFail`'s internal interrupt from firing. Fixed by wrapping the app in `Effect.interruptible` before passing to `timeoutFail` when both options are set, allowing the timeout mechanism to interrupt the handler while the outer `Effect.uninterruptible` still protects against external interrupts (e.g. SIGINT).
- Capture the `consumerTag` from `channel.consume()` and register a scope finalizer to call `channel.cancel(consumerTag)`, ensuring explicit consumer cancellation during graceful shutdown instead of relying solely on channel close.
