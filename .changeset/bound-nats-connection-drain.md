---
"@effect-messaging/nats": patch
---

Bound the NATS connection teardown, release idle subscriptions promptly, and add `drainTimeout` to
`layerNode` / `layerWebSocket`.

Closing the scope of a `NATSConnection` awaited `nc.drain()` with no deadline. `drain()` unsubscribes
and then waits for a PING/PONG round trip before it closes, so a server that has gone silent, a lost
link with reconnects disabled, or a reconnect in progress held the finalizer open indefinitely and
stranded process shutdown until the supervisor resorted to SIGKILL. The finalizer now gives the drain
a budget (5 seconds by default), closes the connection outright once it elapses or the drain fails,
and waits for a drain the application started itself instead of failing on it. A connection whose
`connect()` is interrupted before it resolves is now closed as well.

Independently of the drain, releasing the stream of an idle `NATSSubscription` or JetStream consumer
hung until the next message arrived, because nats-core's async generator queues `return()` behind
its pending `next()`. The subscription is now unsubscribed, and the consumer stopped, when their
stream ends or is interrupted, so the release completes right away.

The budget is raced at the promise level rather than with `Effect.timeout`: finalizers run
uninterruptibly, and an interrupt reaching the fiber mid-teardown would otherwise end the wait early
and skip the close.
