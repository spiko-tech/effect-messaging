# @effect-messaging/amqp

## 0.4.2

### Patch Changes

- [`77e1dbb`](https://github.com/spiko-tech/effect-messaging/commit/77e1dbb5a7685da42844e2bff905ef38506dd608) Thanks [@wewelll](https://github.com/wewelll)! - terminate streams when channel or connection closes

## 0.4.1

### Patch Changes

- [#23](https://github.com/spiko-tech/effect-messaging/pull/23) [`601675a`](https://github.com/spiko-tech/effect-messaging/commit/601675ac04b54885154b2249b22b3f995ac36647) Thanks [@wewelll](https://github.com/wewelll)! - Add spans to all methods of AMQPChannel and AMQPConnection

- [#23](https://github.com/spiko-tech/effect-messaging/pull/23) [`9561652`](https://github.com/spiko-tech/effect-messaging/commit/9561652f70caf3b9f25cd5a48b4362004d96b94b) Thanks [@wewelll](https://github.com/wewelll)! - Add error monitoring on channel and connection

## 0.4.0

### Minor Changes

- [#21](https://github.com/spiko-tech/effect-messaging/pull/21) [`af595e0`](https://github.com/spiko-tech/effect-messaging/commit/af595e09e7ce116487aee68f766777153f4cab6f) Thanks [@wewelll](https://github.com/wewelll)! - Add configurable reconnectionSchedule and waitTimeout for AMQPChannel and AMQPConnection

### Patch Changes

- [#21](https://github.com/spiko-tech/effect-messaging/pull/21) [`1114f04`](https://github.com/spiko-tech/effect-messaging/commit/1114f0410d74c482974d4c48c520c49249f96366) Thanks [@wewelll](https://github.com/wewelll)! - Update effect dependencies

- [#21](https://github.com/spiko-tech/effect-messaging/pull/21) [`af595e0`](https://github.com/spiko-tech/effect-messaging/commit/af595e09e7ce116487aee68f766777153f4cab6f) Thanks [@wewelll](https://github.com/wewelll)! - Add options uninterruptible and handlerTimeout on the AMQPSubscriber

- Updated dependencies [[`1114f04`](https://github.com/spiko-tech/effect-messaging/commit/1114f0410d74c482974d4c48c520c49249f96366)]:
  - @effect-messaging/core@0.2.3

## 0.3.5

### Patch Changes

- [`6262121`](https://github.com/spiko-tech/effect-messaging/commit/626212109cb1334988144f5880e902751d683eef) Thanks [@wewelll](https://github.com/wewelll)! - Bump dependencies

- Updated dependencies [[`6262121`](https://github.com/spiko-tech/effect-messaging/commit/626212109cb1334988144f5880e902751d683eef)]:
  - @effect-messaging/core@0.2.2

## 0.3.4

### Patch Changes

- [#18](https://github.com/spiko-tech/effect-messaging/pull/18) [`51abf13`](https://github.com/spiko-tech/effect-messaging/commit/51abf13b8753fb0bb95437e7ad51cbbbadbf19e9) Thanks [@wewelll](https://github.com/wewelll)! - When requesting a Connection or a Channel, wait for it to be available instead of throwing if unavailable

## 0.3.3

### Patch Changes

- [`a9f7fc0`](https://github.com/spiko-tech/effect-messaging/commit/a9f7fc0229dc7b5315352cde0122c9c6520e7376) Thanks [@wewelll](https://github.com/wewelll)! - Update effect libraries

- Updated dependencies [[`a9f7fc0`](https://github.com/spiko-tech/effect-messaging/commit/a9f7fc0229dc7b5315352cde0122c9c6520e7376)]:
  - @effect-messaging/core@0.2.1

## 0.3.2

### Patch Changes

- [`36767f0`](https://github.com/spiko-tech/effect-messaging/commit/36767f0fff968378a219283d62e1f0c4e4f141a1) Thanks [@wewelll](https://github.com/wewelll)! - Add configurable retry schedule for the AMQPPublisher

## 0.3.1

### Patch Changes

- [`1509d51`](https://github.com/spiko-tech/effect-messaging/commit/1509d516e2d7229a04ae42aa1f709a1ed410d54f) Thanks [@wewelll](https://github.com/wewelll)! - Stop using specific rabbitmq span annotations

## 0.3.0

### Minor Changes

- [#10](https://github.com/spiko-tech/effect-messaging/pull/10) [`5fc42f4`](https://github.com/spiko-tech/effect-messaging/commit/5fc42f46ca99d7224745b8b79dc5f048b54529b9) Thanks [@wewelll](https://github.com/wewelll)! - Add span when a message is published

- [#12](https://github.com/spiko-tech/effect-messaging/pull/12) [`b45785b`](https://github.com/spiko-tech/effect-messaging/commit/b45785bbf261f963a8511cd816e1c25b9257d91c) Thanks [@wewelll](https://github.com/wewelll)! - Add Subscriber with AMQPSubscriber implementation

### Patch Changes

- Updated dependencies [[`b45785b`](https://github.com/spiko-tech/effect-messaging/commit/b45785bbf261f963a8511cd816e1c25b9257d91c)]:
  - @effect-messaging/core@0.2.0

## 0.2.4

### Patch Changes

- Updated dependencies [[`e3ba945`](https://github.com/spiko-tech/effect-messaging/commit/e3ba94598d7150bc273969617df569563885fa8b)]:
  - @effect-messaging/core@0.1.0

## 0.2.3

### Patch Changes

- [`cf079ab`](https://github.com/spiko-tech/effect-messaging/commit/cf079abe0abe713d51f09f92c3837cc7f3276f78) Thanks [@wewelll](https://github.com/wewelll)! - add missing methods on AMQPConnection

- [`a1949f3`](https://github.com/spiko-tech/effect-messaging/commit/a1949f3c39ceec032dce02b02fa949b8b7e5b93f) Thanks [@wewelll](https://github.com/wewelll)! - Add all methods on AMQPChannel

## 0.2.2

### Patch Changes

- [`ebc2fc1`](https://github.com/spiko-tech/effect-messaging/commit/ebc2fc1f5c123c844979d7745cd5ec301132cced) Thanks [@wewelll](https://github.com/wewelll)! - Add serverProperties to AMQPConnection module

## 0.2.1

### Patch Changes

- [`d2b2352`](https://github.com/spiko-tech/effect-messaging/commit/d2b2352239e96b94746e6f7e96b73bdeecd366ee) Thanks [@wewelll](https://github.com/wewelll)! - update effect packages

## 0.2.0

### Minor Changes

- [#1](https://github.com/spiko-tech/effect-messaging/pull/1) [`eba4309`](https://github.com/spiko-tech/effect-messaging/commit/eba430981510a4269df6f1b3235347e2ca4324d8) Thanks [@wewelll](https://github.com/wewelll)! - Add AMQPConnection and AMQPChannel
