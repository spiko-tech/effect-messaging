# `effect-messaging`

A message broker toolkit for Effect.

### AMQP protocol features:

- 🔌 Effectful wrappers for AMQP Connection and Channel
- 🔄 Auto-reconnect functionality when the connection is lost
- 🧘 Seamless consumption continuation after reconnection
- 🔭 Distributed tracing support (spans propagate from publishers to subscribers)

> [!WARNING]
> This project is currently **under development**. Please note that future releases might introduce breaking changes.

## Roadmap

- [x] Common abstractions for message brokers: `@effect-messaging/core`

  - [x] Add a `Publisher` interface
  - [x] Add a `Subscriber` interface

- [ ] Implementations for the AMQP protocol: `@effect-messaging/amqp`

  - [x] Effect wrappers for AMQP Connection & AMQP Channel
  - [x] Implement publisher and subscriber
  - [x] Integration tests
  - [ ] Add examples & documentation
