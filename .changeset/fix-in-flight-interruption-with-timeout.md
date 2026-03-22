---
"@effect-messaging/core": patch
---

Fix in-flight handler interruption when `handlerTimeout` is configured.

Previously, `Effect.interruptible` inside the `Effect.uninterruptible` region
reopened the handler to external fiber interruption (e.g. SIGINT / graceful
shutdown), causing in-flight handlers to be killed instead of completing.

The fix uses `Effect.forkIn` to run the handler in a separate fiber scope,
making it interruptible by the timeout but not by parent fiber interruption.
