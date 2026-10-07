---
"@effect-messaging/core": major
"@effect-messaging/amqp": major
"@effect-messaging/nats": major
---

Migrate messaging packages to Effect 4.0.2, remove the @effect/platform peer dependency,
and upgrade amqplib to 2.2.0.

- Publish ESM-only packages with explicit public exports.
- Preserve AMQP close events and scope resource listeners for Effect 4.0.2.
- Simplify TypeScript 7.0.2 build/release tooling.
