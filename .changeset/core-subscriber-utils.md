---
"@effect-messaging/core": minor
---

Add `SubscriberUtils` module with reusable utilities for subscriber implementations:

- `makeHandlerRunner` — creates a FiberSet-backed handler runner with graceful drain support and optional drain timeout
- `withTimeout` — applies handler timeout correctly in both interruptible and uninterruptible contexts (using a Fiber-based race when uninterruptible)
