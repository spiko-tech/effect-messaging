---
"@effect-messaging/amqp": patch
---

Bound the confirm drain on channel close at the promise level. Closing a channel opened with
`confirm: true` waits, up to `confirmTimeout`, for outstanding publisher confirms before it removes
amqplib's listeners. That wait was bounded with `Effect.timeout`, which never fires inside a scope
finalizer because finalizers run uninterruptibly, so a broker withholding confirms could hold the
scope close open indefinitely. The wait is now raced against a timer on the promise itself.
