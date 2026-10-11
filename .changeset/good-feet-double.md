---
"@effect-messaging/nats": patch
---

Fix review regressions in the Effect 4.0.2 native NATS client audited against nats.js 3.4.0 and NATS 2.15.0: retain ordered delivery cursors atomically under backpressure, suspend heartbeat monitoring during blocked admission, terminate forced reconnect on closure, separate inbound payload bounds from outbound budgets, charge complete messages against subscription byte limits, and recheck multi-request deadlines after scheduler wakeups.

Retry concrete Docker port allocation collisions in NATS 2.15.0 integration fixtures on Linux as well as macOS.
