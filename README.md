# `effect-messaging`

A message broker toolkit for Effect.

### AMQP protocol features:

- 🔌 Effectful wrappers for AMQP Connection and Channel
- 🔄 Auto-reconnect functionality when the connection is lost
- 🧘 Seamless consumption continuation after reconnection

> [!WARNING]
> This project is currently **under development**. Please note that future releases might introduce breaking changes.

## Roadmap

- [ ] Common abstractions for message brokers

  - [ ] Create a new package @effect-messaging/publisher
  - [ ] Create a new package @effect-messaging/subscriber

- [ ] Implementations for the AMQP protocol

  - [x] Effect wrappers for AMQP Connection & AMQP Channel
  - [ ] Integration tests
  - [ ] Implement publisher and subscriber
