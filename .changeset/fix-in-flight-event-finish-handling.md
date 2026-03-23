---
"@effect-messaging/core": patch
---

Fix event handler being interrupted directly on SIGINT when handlerTimeout is set. `Effect.timeoutFail` relies on interruption internally, which does not work inside `Effect.uninterruptible`. The fix uses a Fiber-based race instead: the app is forked in an interruptible region so the timeout can interrupt it.
