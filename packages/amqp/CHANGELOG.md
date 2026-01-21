# @effect-messaging/amqp

## 0.5.1

### Patch Changes

- [#120](https://github.com/spiko-tech/effect-messaging/pull/120) [`d439eed`](https://github.com/spiko-tech/effect-messaging/commit/d439eeded70ef26e57600bdac3acecf7c7455b9b) Thanks [@wewelll](https://github.com/wewelll)! - Fix error span attributes for Datadog error tracking

  - Changed `tag` to `_tag` property check to correctly extract error type from Effect's TaggedError
  - Wrapped `Cause.squashWith` calls in `String()` to ensure span attributes are always strings
  - This ensures `error.type`, `error.message`, and `error.stack` are properly set for Datadog error tracking

## 0.5.0

### Minor Changes

- [#115](https://github.com/spiko-tech/effect-messaging/pull/115) [`2b26c0d`](https://github.com/spiko-tech/effect-messaging/commit/2b26c0d3a217616bed3d8a9d7eb03eba47f17646) Thanks [@wewelll](https://github.com/wewelll)! - Add subscriber response types for explicit message acknowledgment control

  - Added response type parameter to Subscriber interface in core
  - Added AMQPSubscriberResponse module with Ack, Nack, and Reject response types
  - Added JetStreamSubscriberResponse module with Ack, Nak, and Term response types
  - Subscribers now return a response to control message acknowledgment behavior
  - On handler error, messages are still nacked/rejected automatically

### Patch Changes

- Updated dependencies [[`2b26c0d`](https://github.com/spiko-tech/effect-messaging/commit/2b26c0d3a217616bed3d8a9d7eb03eba47f17646)]:
  - @effect-messaging/core@0.2.39

## 0.4.40

### Patch Changes

- [#113](https://github.com/spiko-tech/effect-messaging/pull/113) [`5f72eba`](https://github.com/spiko-tech/effect-messaging/commit/5f72ebafae4ac683c42a0798588108a0758e6de8) Thanks [@wewelll](https://github.com/wewelll)! - upgrade effect libraries to their latest version

- Updated dependencies [[`5f72eba`](https://github.com/spiko-tech/effect-messaging/commit/5f72ebafae4ac683c42a0798588108a0758e6de8)]:
  - @effect-messaging/core@0.2.38

## 0.4.39

### Patch Changes

- [#105](https://github.com/spiko-tech/effect-messaging/pull/105) [`90904f8`](https://github.com/spiko-tech/effect-messaging/commit/90904f8ed54119393663b69814f0d1804f70eed2) Thanks [@wewelll](https://github.com/wewelll)! - Upgrade effect to 3.19.12, @effect/platform to 0.93.8, and @effect/language-service to 0.62.3

- Updated dependencies [[`90904f8`](https://github.com/spiko-tech/effect-messaging/commit/90904f8ed54119393663b69814f0d1804f70eed2)]:
  - @effect-messaging/core@0.2.37

## 0.4.38

### Patch Changes

- [#98](https://github.com/spiko-tech/effect-messaging/pull/98) [`9492829`](https://github.com/spiko-tech/effect-messaging/commit/9492829c1cc222084c5debaf598888cff1abe3a9) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade effect libraries to latest versions: effect 3.19.8 → 3.19.10, @effect/language-service 0.58.3 → 0.61.0

- Updated dependencies [[`9492829`](https://github.com/spiko-tech/effect-messaging/commit/9492829c1cc222084c5debaf598888cff1abe3a9)]:
  - @effect-messaging/core@0.2.36

## 0.4.37

### Patch Changes

- [#95](https://github.com/spiko-tech/effect-messaging/pull/95) [`9eea45b`](https://github.com/spiko-tech/effect-messaging/commit/9eea45b1920c7c8aa514ce7a57f427c0cec51a5e) Thanks [@wewelll](https://github.com/wewelll)! - Update effect to 3.19.8 and @effect/platform to 0.93.6

- Updated dependencies [[`9eea45b`](https://github.com/spiko-tech/effect-messaging/commit/9eea45b1920c7c8aa514ce7a57f427c0cec51a5e)]:
  - @effect-messaging/core@0.2.35

## 0.4.36

### Patch Changes

- [#92](https://github.com/spiko-tech/effect-messaging/pull/92) [`d145cdc`](https://github.com/spiko-tech/effect-messaging/commit/d145cdca0659fc68a1ce5ba3cdf75ca856da70c9) Thanks [@wewelll](https://github.com/wewelll)! - add spans to amqp publish method

## 0.4.35

### Patch Changes

- [#89](https://github.com/spiko-tech/effect-messaging/pull/89) [`53ec375`](https://github.com/spiko-tech/effect-messaging/commit/53ec37535faf33a558148ca9d6c1ac24b93c41de) Thanks [@wewelll](https://github.com/wewelll)! - Upgrade Effect dependencies to latest versions:

  - effect: 3.19.3 → 3.19.4
  - @effect/platform: 0.93.1 → 0.93.2
  - @effect/language-service: 0.55.3 → 0.56.0

- Updated dependencies [[`53ec375`](https://github.com/spiko-tech/effect-messaging/commit/53ec37535faf33a558148ca9d6c1ac24b93c41de)]:
  - @effect-messaging/core@0.2.34

## 0.4.34

### Patch Changes

- [#86](https://github.com/spiko-tech/effect-messaging/pull/86) [`1163112`](https://github.com/spiko-tech/effect-messaging/commit/11631129893e21e8768173f051c90757baee2e48) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade effect from ^3.19.2 to ^3.19.3 and @effect/platform from ^0.93.0 to ^0.93.1

- Updated dependencies [[`1163112`](https://github.com/spiko-tech/effect-messaging/commit/11631129893e21e8768173f051c90757baee2e48)]:
  - @effect-messaging/core@0.2.33

## 0.4.33

### Patch Changes

- [#84](https://github.com/spiko-tech/effect-messaging/pull/84) [`3b1e71a`](https://github.com/spiko-tech/effect-messaging/commit/3b1e71a6b3070fd05e2340edbe59beb8a0dcf4ea) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade effect dependencies: effect 3.19.0 -> 3.19.2, @effect/language-service 0.55.0 -> 0.55.2

- Updated dependencies [[`3b1e71a`](https://github.com/spiko-tech/effect-messaging/commit/3b1e71a6b3070fd05e2340edbe59beb8a0dcf4ea)]:
  - @effect-messaging/core@0.2.32

## 0.4.32

### Patch Changes

- [#82](https://github.com/spiko-tech/effect-messaging/pull/82) [`b27d45c`](https://github.com/spiko-tech/effect-messaging/commit/b27d45cf138964c9e7cd98388967f9e270f1c57b) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade effect libraries: effect to 3.19.0, @effect/platform to 0.93.0, @effect/vitest to 0.27.0, @effect/language-service to 0.55.0

- Updated dependencies [[`b27d45c`](https://github.com/spiko-tech/effect-messaging/commit/b27d45cf138964c9e7cd98388967f9e270f1c57b)]:
  - @effect-messaging/core@0.2.31

## 0.4.31

### Patch Changes

- [#79](https://github.com/spiko-tech/effect-messaging/pull/79) [`7d2e9a1`](https://github.com/spiko-tech/effect-messaging/commit/7d2e9a1b5e7e0cb93416259863dcdb2f98eaa986) Thanks [@wewelll](https://github.com/wewelll)! - remove devengines

- Updated dependencies [[`7d2e9a1`](https://github.com/spiko-tech/effect-messaging/commit/7d2e9a1b5e7e0cb93416259863dcdb2f98eaa986)]:
  - @effect-messaging/core@0.2.30

## 0.4.30

### Patch Changes

- [#77](https://github.com/spiko-tech/effect-messaging/pull/77) [`15d0a45`](https://github.com/spiko-tech/effect-messaging/commit/15d0a450bdb13d9d1345d699a7c994146246bd3b) Thanks [@wewelll](https://github.com/wewelll)! - add environment for release job

- Updated dependencies [[`15d0a45`](https://github.com/spiko-tech/effect-messaging/commit/15d0a450bdb13d9d1345d699a7c994146246bd3b)]:
  - @effect-messaging/core@0.2.29

## 0.4.29

### Patch Changes

- [#75](https://github.com/spiko-tech/effect-messaging/pull/75) [`3341ea1`](https://github.com/spiko-tech/effect-messaging/commit/3341ea1de92d1bef8ce2658ee324e9989a032008) Thanks [@wewelll](https://github.com/wewelll)! - Update to NodeJS 24

- Updated dependencies [[`3341ea1`](https://github.com/spiko-tech/effect-messaging/commit/3341ea1de92d1bef8ce2658ee324e9989a032008)]:
  - @effect-messaging/core@0.2.28

## 0.4.28

### Patch Changes

- [#73](https://github.com/spiko-tech/effect-messaging/pull/73) [`e56021b`](https://github.com/spiko-tech/effect-messaging/commit/e56021be866d7faccc519c2fb0aa5ba6e2283c51) Thanks [@wewelll](https://github.com/wewelll)! - try fixing release

- Updated dependencies [[`e56021b`](https://github.com/spiko-tech/effect-messaging/commit/e56021be866d7faccc519c2fb0aa5ba6e2283c51)]:
  - @effect-messaging/core@0.2.27

## 0.4.27

### Patch Changes

- [#70](https://github.com/spiko-tech/effect-messaging/pull/70) [`b6feab9`](https://github.com/spiko-tech/effect-messaging/commit/b6feab95132c2c5065c4b377a75dde91a1483f94) Thanks [@wewelll](https://github.com/wewelll)! - Add NPM_TOKEN workaround to release workflow while changesets issue #1152 is open.

- Updated dependencies [[`b6feab9`](https://github.com/spiko-tech/effect-messaging/commit/b6feab95132c2c5065c4b377a75dde91a1483f94)]:
  - @effect-messaging/core@0.2.26

## 0.4.26

### Patch Changes

- [#68](https://github.com/spiko-tech/effect-messaging/pull/68) [`116fa92`](https://github.com/spiko-tech/effect-messaging/commit/116fa925fa46a21f4230543fc94f5086bc7e9755) Thanks [@wewelll](https://github.com/wewelll)! - Upgrade Effect libraries to latest versions (effect ^3.18.4, @effect/language-service ^0.46.0)

- Updated dependencies [[`116fa92`](https://github.com/spiko-tech/effect-messaging/commit/116fa925fa46a21f4230543fc94f5086bc7e9755)]:
  - @effect-messaging/core@0.2.25

## 0.4.25

### Patch Changes

- [#65](https://github.com/spiko-tech/effect-messaging/pull/65) [`d11daed`](https://github.com/spiko-tech/effect-messaging/commit/d11daed7d335b5edae0ee0cba4124cfd058b2f55) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.18.3, @effect/language-service ^0.42.0)

- Updated dependencies [[`d11daed`](https://github.com/spiko-tech/effect-messaging/commit/d11daed7d335b5edae0ee0cba4124cfd058b2f55)]:
  - @effect-messaging/core@0.2.24

## 0.4.24

### Patch Changes

- [#63](https://github.com/spiko-tech/effect-messaging/pull/63) [`84157e4`](https://github.com/spiko-tech/effect-messaging/commit/84157e4289c7d6b99dfaa1b26f23a6ed7e1cf166) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.18.2)

- Updated dependencies [[`84157e4`](https://github.com/spiko-tech/effect-messaging/commit/84157e4289c7d6b99dfaa1b26f23a6ed7e1cf166)]:
  - @effect-messaging/core@0.2.23

## 0.4.23

### Patch Changes

- [#61](https://github.com/spiko-tech/effect-messaging/pull/61) [`eaad7c3`](https://github.com/spiko-tech/effect-messaging/commit/eaad7c32568c875e7a733e5e7307e257e62adbec) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.18.1, @effect/platform ^0.92.1, @effect/language-service ^0.41.1, @effect/vitest ^0.26.0)

- Updated dependencies [[`eaad7c3`](https://github.com/spiko-tech/effect-messaging/commit/eaad7c32568c875e7a733e5e7307e257e62adbec)]:
  - @effect-messaging/core@0.2.22

## 0.4.22

### Patch Changes

- [#59](https://github.com/spiko-tech/effect-messaging/pull/59) [`7bfbc02`](https://github.com/spiko-tech/effect-messaging/commit/7bfbc021e168661a3e0fbd2aa6272f7fa609e965) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.17.14, @effect/platform ^0.91.1, @effect/language-service ^0.41.0)

- Updated dependencies [[`7bfbc02`](https://github.com/spiko-tech/effect-messaging/commit/7bfbc021e168661a3e0fbd2aa6272f7fa609e965)]:
  - @effect-messaging/core@0.2.21

## 0.4.21

### Patch Changes

- [#57](https://github.com/spiko-tech/effect-messaging/pull/57) [`f438902`](https://github.com/spiko-tech/effect-messaging/commit/f438902707082f49802bbdb03da497ccd5be99d7) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.17.13, @effect/platform ^0.90.9, @effect/language-service ^0.40.0)

- Updated dependencies [[`f438902`](https://github.com/spiko-tech/effect-messaging/commit/f438902707082f49802bbdb03da497ccd5be99d7)]:
  - @effect-messaging/core@0.2.20

## 0.4.20

### Patch Changes

- [#54](https://github.com/spiko-tech/effect-messaging/pull/54) [`b64d91f`](https://github.com/spiko-tech/effect-messaging/commit/b64d91f2427b0e6b30be744731192e0c153772dc) Thanks [@wewelll](https://github.com/wewelll)! - Update amqplib dependency from ^0.10.5 to ^0.10.9 and @types/amqplib from 0.10.6 to 0.10.7

## 0.4.19

### Patch Changes

- [#52](https://github.com/spiko-tech/effect-messaging/pull/52) [`c65159c`](https://github.com/spiko-tech/effect-messaging/commit/c65159c7fbc9bb77103a3e932f33e4b6f8326a67) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect library to latest version (effect ^3.17.10)

- Updated dependencies [[`c65159c`](https://github.com/spiko-tech/effect-messaging/commit/c65159c7fbc9bb77103a3e932f33e4b6f8326a67)]:
  - @effect-messaging/core@0.2.19

## 0.4.18

### Patch Changes

- [#50](https://github.com/spiko-tech/effect-messaging/pull/50) [`0d1915b`](https://github.com/spiko-tech/effect-messaging/commit/0d1915b659ce8472bf82a3adb8815d3a9fb1783c) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.17.9, @effect/platform ^0.90.6, @effect/language-service ^0.36.0)

- Updated dependencies [[`0d1915b`](https://github.com/spiko-tech/effect-messaging/commit/0d1915b659ce8472bf82a3adb8815d3a9fb1783c)]:
  - @effect-messaging/core@0.2.18

## 0.4.17

### Patch Changes

- [#48](https://github.com/spiko-tech/effect-messaging/pull/48) [`75d83d0`](https://github.com/spiko-tech/effect-messaging/commit/75d83d05a75cb4483cee522c81861825b52c601f) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade TypeScript to ^5.9.2 and related TypeScript ESLint packages to ^8.39.1

- Updated dependencies [[`75d83d0`](https://github.com/spiko-tech/effect-messaging/commit/75d83d05a75cb4483cee522c81861825b52c601f)]:
  - @effect-messaging/core@0.2.17

## 0.4.16

### Patch Changes

- [#46](https://github.com/spiko-tech/effect-messaging/pull/46) [`54a3ca2`](https://github.com/spiko-tech/effect-messaging/commit/54a3ca2c4da6d8151435582c088fb36d77f2ff14) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.17.7, @effect/platform ^0.90.3, @effect/language-service ^0.35.2, @effect/vitest ^0.25.1)

- Updated dependencies [[`54a3ca2`](https://github.com/spiko-tech/effect-messaging/commit/54a3ca2c4da6d8151435582c088fb36d77f2ff14)]:
  - @effect-messaging/core@0.2.16

## 0.4.15

### Patch Changes

- [#42](https://github.com/spiko-tech/effect-messaging/pull/42) [`8fe28e2`](https://github.com/spiko-tech/effect-messaging/commit/8fe28e2b6b79596222af0169b3acd37e3ee1de91) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.17.6, @effect/language-service ^0.33.2)

- Updated dependencies [[`8fe28e2`](https://github.com/spiko-tech/effect-messaging/commit/8fe28e2b6b79596222af0169b3acd37e3ee1de91)]:
  - @effect-messaging/core@0.2.15

## 0.4.14

### Patch Changes

- [#40](https://github.com/spiko-tech/effect-messaging/pull/40) [`53ffafa`](https://github.com/spiko-tech/effect-messaging/commit/53ffafada29728eff415fe6c1d502e1cc283786b) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.17.3, @effect/platform ^0.90.0)

- Updated dependencies [[`53ffafa`](https://github.com/spiko-tech/effect-messaging/commit/53ffafada29728eff415fe6c1d502e1cc283786b)]:
  - @effect-messaging/core@0.2.14

## 0.4.13

### Patch Changes

- [#38](https://github.com/spiko-tech/effect-messaging/pull/38) [`e663381`](https://github.com/spiko-tech/effect-messaging/commit/e66338107bb262a0a94510a17f64f04af73443dc) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Upgrade Effect libraries to latest versions (effect ^3.16.13, @effect/platform ^0.88.0, etc.)

- Updated dependencies [[`e663381`](https://github.com/spiko-tech/effect-messaging/commit/e66338107bb262a0a94510a17f64f04af73443dc)]:
  - @effect-messaging/core@0.2.13

## 0.4.12

### Patch Changes

- [`d46fe2b`](https://github.com/spiko-tech/effect-messaging/commit/d46fe2bb6c4b795a9ddab0155ef8fcaa91ea3dcd) Thanks [@wewelll](https://github.com/wewelll)! - update effect

- Updated dependencies [[`d46fe2b`](https://github.com/spiko-tech/effect-messaging/commit/d46fe2bb6c4b795a9ddab0155ef8fcaa91ea3dcd)]:
  - @effect-messaging/core@0.2.12

## 0.4.11

### Patch Changes

- [#34](https://github.com/spiko-tech/effect-messaging/pull/34) [`b36a804`](https://github.com/spiko-tech/effect-messaging/commit/b36a80431ce19a91a156c499a86d82bea35e856d) Thanks [@wewelll](https://github.com/wewelll)! - Update effect

- Updated dependencies [[`b36a804`](https://github.com/spiko-tech/effect-messaging/commit/b36a80431ce19a91a156c499a86d82bea35e856d)]:
  - @effect-messaging/core@0.2.11

## 0.4.10

### Patch Changes

- [`91900c7`](https://github.com/spiko-tech/effect-messaging/commit/91900c7ee12fd326050aea015e4f048c6f3263b5) Thanks [@wewelll](https://github.com/wewelll)! - update effect dependencies

- Updated dependencies [[`91900c7`](https://github.com/spiko-tech/effect-messaging/commit/91900c7ee12fd326050aea015e4f048c6f3263b5)]:
  - @effect-messaging/core@0.2.10

## 0.4.9

### Patch Changes

- [`ec2333e`](https://github.com/spiko-tech/effect-messaging/commit/ec2333e04ed427fce4a8a615f7aeb7f6fd99f45f) Thanks [@wewelll](https://github.com/wewelll)! - update effect dependencies

- Updated dependencies [[`ec2333e`](https://github.com/spiko-tech/effect-messaging/commit/ec2333e04ed427fce4a8a615f7aeb7f6fd99f45f)]:
  - @effect-messaging/core@0.2.9

## 0.4.8

### Patch Changes

- [`50834b8`](https://github.com/spiko-tech/effect-messaging/commit/50834b82414b7519ee8dbf1e3321c6beae756fcf) Thanks [@wewelll](https://github.com/wewelll)! - Add @effect/language-service

- [`ef8ad8a`](https://github.com/spiko-tech/effect-messaging/commit/ef8ad8adee978d64d3cb492189b1c0b38713d4a7) Thanks [@wewelll](https://github.com/wewelll)! - update effect dependencies

- Updated dependencies [[`50834b8`](https://github.com/spiko-tech/effect-messaging/commit/50834b82414b7519ee8dbf1e3321c6beae756fcf), [`ef8ad8a`](https://github.com/spiko-tech/effect-messaging/commit/ef8ad8adee978d64d3cb492189b1c0b38713d4a7)]:
  - @effect-messaging/core@0.2.8

## 0.4.7

### Patch Changes

- [`1c53254`](https://github.com/spiko-tech/effect-messaging/commit/1c532542fc80f4548f3bbc44d4d825a34b27fb6a) Thanks [@wewelll](https://github.com/wewelll)! - Update effect dependencies

- Updated dependencies [[`1c53254`](https://github.com/spiko-tech/effect-messaging/commit/1c532542fc80f4548f3bbc44d4d825a34b27fb6a)]:
  - @effect-messaging/core@0.2.7

## 0.4.6

### Patch Changes

- [`ff66334`](https://github.com/spiko-tech/effect-messaging/commit/ff663342567c66e10c7ab23e0496d85be18715b9) Thanks [@wewelll](https://github.com/wewelll)! - Update Effect dependencies

- Updated dependencies [[`ff66334`](https://github.com/spiko-tech/effect-messaging/commit/ff663342567c66e10c7ab23e0496d85be18715b9)]:
  - @effect-messaging/core@0.2.6

## 0.4.5

### Patch Changes

- [`4b900cb`](https://github.com/spiko-tech/effect-messaging/commit/4b900cb7b345c927114722eada062effb6e6469d) Thanks [@wewelll](https://github.com/wewelll)! - Update effect libraries

- Updated dependencies [[`4b900cb`](https://github.com/spiko-tech/effect-messaging/commit/4b900cb7b345c927114722eada062effb6e6469d)]:
  - @effect-messaging/core@0.2.5

## 0.4.4

### Patch Changes

- [`c040e9e`](https://github.com/spiko-tech/effect-messaging/commit/c040e9ed32aaae9777e6a8bfef703e469ac46ead) Thanks [@wewelll](https://github.com/wewelll)! - Update effect dependencies

- Updated dependencies [[`c040e9e`](https://github.com/spiko-tech/effect-messaging/commit/c040e9ed32aaae9777e6a8bfef703e469ac46ead)]:
  - @effect-messaging/core@0.2.4

## 0.4.3

### Patch Changes

- [`26fd090`](https://github.com/spiko-tech/effect-messaging/commit/26fd090ea6d85b069034fa35a639f9f29a86af1f) Thanks [@wewelll](https://github.com/wewelll)! - emit a failure in the consume stream if channel.consume rejects

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
