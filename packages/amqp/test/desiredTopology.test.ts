import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Buffer } from "node:buffer"
import type * as AMQPTopology from "../src/AMQPTopology.ts"
import type * as AMQPTypes from "../src/AMQPTypes.ts"
import * as DesiredTopology from "../src/internal/desiredTopology.ts"

const reply = (queue: string): AMQPTypes.QueueReply => ({ queue, messageCount: 0, consumerCount: 0 })
const exchange = (name: string): DesiredTopology.ExchangeDeclaration => ({
  exchange: name,
  type: "direct",
  options: {}
})
const binding = (
  queue: AMQPTopology.QueueName,
  arguments_: AMQPTypes.FieldTable = {}
): DesiredTopology.Binding => ({ queue, source: "source", routingKey: "key", arguments: arguments_ })

const recorder = (events: Array<string> = [], owner = "owner") => {
  const exchanges: Array<DesiredTopology.ExchangeDeclaration> = []
  const queues: Array<{
    requested: string
    options: AMQPTypes.QueueOptions
  }> = []
  const bindings: Array<DesiredTopology.Binding> = []
  const consumers: Array<string> = []
  const restorer: DesiredTopology.Restorer<AMQPTopology.QueueName, string> = {
    exchange: (declaration) =>
      Effect.sync(() => {
        events.push(`${owner}:exchange`)
        exchanges.push(declaration)
      }),
    queue: (requested, options) =>
      Effect.sync(() => {
        events.push(`${owner}:queue`)
        queues.push({ requested, options })
        return reply(requested === "" ? `${owner}-regenerated` : requested)
      }),
    binding: (declaration) =>
      Effect.sync(() => {
        events.push(`${owner}:binding`)
        bindings.push(declaration)
      }),
    consumer: (consumer) =>
      Effect.sync(() => {
        events.push(`${owner}:consumer`)
        consumers.push(DesiredTopology.queueName(consumer))
      }),
    ready: () => {
      events.push(`${owner}:ready`)
    }
  }
  return { restorer, exchanges, queues, bindings, consumers }
}

const applyBinding = Effect.fnUntraced(function*(
  topology: ReturnType<typeof DesiredTopology.make<object, AMQPTopology.QueueName>>,
  owner: object,
  value: DesiredTopology.Binding,
  remove: boolean
) {
  const prepared = yield* topology.prepareBinding(owner, value, remove)
  prepared.commit()
})

describe("desired topology", () => {
  it.effect("prepares immutable binding arguments before the broker wait and commits without another Effect", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      const arguments_ = { nested: { label: "before" } }
      const prepared = yield* topology.prepareBinding(owner, binding("queue", arguments_), false)
      arguments_.nested.label = "after"
      const before = recorder()
      yield* topology.restore([owner], () => before.restorer, (_owner, error) => Effect.fail(error))
      expect(before.bindings).toEqual([])
      expect(prepared.binding.arguments).toEqual({ nested: { label: "before" } })
      prepared.commit()
      const bound = recorder()
      yield* topology.restore([owner], () => bound.restorer, (_owner, error) => Effect.fail(error))
      expect(bound.bindings).toEqual([binding("queue", { nested: { label: "before" } })])
      const removal = { ...prepared.binding }
      const unbind = yield* topology.prepareBinding(owner, removal, true)
      removal.routingKey = "changed-after-preparation"
      removal.source = "other-source"
      unbind.commit()
      const after = recorder()
      yield* topology.restore([owner], () => after.restorer, (_owner, error) => Effect.fail(error))
      expect(after.bindings).toEqual([])
    }))

  it.effect("restores global phases and regenerates cross-channel references before dependent work", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const first = {}
      const second = {}
      const events: Array<string> = []
      const a = recorder(events, "first")
      const b = recorder(events, "second")
      const firstQueue = topology.queueDeclared(first, "", {}, reply("old-first"))
      const secondQueue = topology.queueDeclared(second, "", {}, reply("old-second"))
      for (const owner of [first, second]) topology.exchangeDeclared(owner, exchange("source"))
      yield* applyBinding(topology, first, binding(secondQueue), false)
      yield* applyBinding(topology, second, binding(firstQueue), false)
      topology.addConsumer(first, secondQueue)
      topology.addConsumer(second, firstQueue)
      const checkReferences = () => {
        expect(firstQueue.queue).toBe("first-regenerated")
        expect(secondQueue.queue).toBe("second-regenerated")
      }
      const target = (owner: object): DesiredTopology.Restorer<AMQPTopology.QueueName, string> => {
        const base = owner === first ? a.restorer : b.restorer
        return {
          ...base,
          binding: (value) =>
            Effect.gen(function*() {
              checkReferences()
              yield* base.binding(value)
            }),
          consumer: (value) =>
            Effect.gen(function*() {
              checkReferences()
              yield* base.consumer(value)
            })
        }
      }
      yield* topology.restore([first, second], target, (_owner, error) => Effect.fail(error))
      expect(events).toEqual([
        "first:exchange",
        "second:exchange",
        "first:queue",
        "second:queue",
        "first:binding",
        "second:binding",
        "first:consumer",
        "first:ready",
        "second:consumer",
        "second:ready"
      ])
      expect(a.consumers).toEqual(["second-regenerated"])
      expect(b.consumers).toEqual(["first-regenerated"])
    }))

  it.effect("deduplicates canonical nested arguments without erasing AMQP field types", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      const observed = recorder()
      const original = binding("queue", {
        nested: { z: [new Date(1000), new Uint8Array([1, 2]), { _tag: "Decimal", scale: 2, value: 123 }], a: true },
        label: "same"
      })
      yield* applyBinding(topology, owner, original, false)
      yield* applyBinding(
        topology,
        owner,
        binding("queue", {
          label: "same",
          nested: { a: true, z: [new Date(1000), new Uint8Array([1, 2]), { value: 123, scale: 2, _tag: "Decimal" }] }
        }),
        false
      )
      const distinctions: Array<AMQPTypes.FieldValue> = [
        new Date(1000),
        1,
        new Uint8Array([1, 2]),
        [1, 2],
        { _tag: "Decimal", scale: 2, value: 123 },
        { scale: 2, value: 123 }
      ]
      for (const value of distinctions) {
        yield* applyBinding(topology, owner, binding("queue", { nested: { value } }), false)
      }
      yield* topology.restore([owner], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.bindings).toEqual([
        original,
        ...distinctions.map((value) => binding("queue", { nested: { value } }))
      ])
    }))

  it.effect("unbinds resolved queue names across owners while retaining different arguments", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const first = {}
      const second = {}
      const queue = topology.queueDeclared(first, "", {}, reply("resolved"))
      yield* applyBinding(topology, first, binding(queue, { nested: { a: 1, b: 2 } }), false)
      yield* applyBinding(topology, second, binding("resolved", { nested: { b: 2, a: 1 } }), false)
      const retained = binding("resolved", { nested: { a: 2, b: 2 } })
      yield* applyBinding(topology, second, retained, false)
      yield* applyBinding(topology, {}, binding("resolved", { nested: { b: 2, a: 1 } }), true)
      const observed = recorder()
      yield* topology.restore([first, second], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.bindings).toEqual([retained])
      expect(observed.queues.map((item) => item.requested)).toEqual([""])
    }))

  it.effect("deduplicates and unbinds tables with distinct Unicode keys regardless of insertion order", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      const first = binding("queue", { nested: { "\u00e9": 1, "e\u0301": 2 } })
      const reversed = binding("queue", { nested: { "e\u0301": 2, "\u00e9": 1 } })
      yield* applyBinding(topology, owner, first, false)
      yield* applyBinding(topology, owner, reversed, false)
      const before = recorder()
      yield* topology.restore([owner], () => before.restorer, (_owner, error) => Effect.fail(error))
      expect(before.bindings).toEqual([first])
      yield* applyBinding(topology, {}, reversed, true)
      const after = recorder()
      yield* topology.restore([owner], () => after.restorer, (_owner, error) => Effect.fail(error))
      expect(after.bindings).toEqual([])
    }))

  it.effect("treats argument tables as tables even when they contain decimal-shaped metadata", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      const original = binding("queue", { _tag: "Decimal", scale: 1, value: 2 })
      const reversed = binding("queue", { value: 2, scale: 1, _tag: "Decimal" })
      yield* applyBinding(topology, owner, original, false)
      yield* applyBinding(topology, owner, reversed, false)
      const before = recorder()
      yield* topology.restore([owner], () => before.restorer, (_owner, error) => Effect.fail(error))
      expect(before.bindings).toEqual([original])
      yield* applyBinding(topology, {}, reversed, true)
      const after = recorder()
      yield* topology.restore([owner], () => after.restorer, (_owner, error) => Effect.fail(error))
      expect(after.bindings).toEqual([])
    }))

  it.effect("deletes matching queues and bindings globally without removing other declarations", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const first = {}
      const second = {}
      const deleted = topology.queueDeclared(first, "", {}, reply("deleted"))
      topology.queueDeclared(second, "deleted", {}, reply("deleted"))
      topology.queueDeclared(second, "kept", {}, reply("kept"))
      topology.exchangeDeclared(first, exchange("source"))
      yield* applyBinding(topology, first, binding(deleted), false)
      yield* applyBinding(topology, second, binding("deleted"), false)
      const retained = binding("kept")
      yield* applyBinding(topology, second, retained, false)
      const exchangeBinding = { source: "source", destination: "destination", routingKey: "key", arguments: {} }
      yield* applyBinding(topology, first, exchangeBinding, false)
      topology.queueDeleted("deleted")
      const observed = recorder()
      yield* topology.restore([first, second], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.queues.map((item) => item.requested)).toEqual(["kept"])
      expect(observed.bindings).toEqual([exchangeBinding, retained])
      expect(observed.exchanges).toEqual([exchange("source")])
    }))

  it.effect("deletes exchange declarations and source or destination bindings across owners", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const first = {}
      const second = {}
      for (const owner of [first, second]) topology.exchangeDeclared(owner, exchange("deleted"))
      topology.exchangeDeclared(second, exchange("source"))
      topology.queueDeclared(first, "kept", {}, reply("kept"))
      yield* applyBinding(topology, first, { ...binding("kept"), source: "deleted" }, false)
      yield* applyBinding(topology, second, {
        source: "source",
        destination: "deleted",
        routingKey: "key",
        arguments: {}
      }, false)
      const retained = binding("kept")
      yield* applyBinding(topology, second, retained, false)
      topology.exchangeDeleted("deleted")
      const observed = recorder()
      yield* topology.restore([first, second], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.exchanges).toEqual([exchange("source")])
      expect(observed.bindings).toEqual([retained])
      expect(observed.queues.map((item) => item.requested)).toEqual(["kept"])
    }))

  it.effect("does not restore unregistered consumers or removed owners' declarations", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const removed = {}
      const survivor = {}
      topology.exchangeDeclared(removed, exchange("removed"))
      topology.queueDeclared(removed, "removed", { autoDelete: true }, reply("removed"))
      yield* applyBinding(topology, removed, binding("removed"), false)
      topology.addConsumer(removed, "removed")
      topology.addConsumer(survivor, "cancelled")
      topology.addConsumer(survivor, "kept")
      topology.removeConsumer(survivor, "cancelled")
      topology.remove(removed)
      expect(topology.hasEphemeralQueues(removed)).toBe(false)
      expect(Array.from(topology.consumers(survivor))).toEqual(["kept"])
      const observed = recorder()
      yield* topology.restore([removed, survivor], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.exchanges).toEqual([])
      expect(observed.queues).toEqual([])
      expect(observed.bindings).toEqual([])
      expect(observed.consumers).toEqual(["kept"])
    }))

  it.effect("lets owner error policy disable later phases while surviving owners complete", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const failed = {}
      const survivor = {}
      for (const owner of [failed, survivor]) {
        topology.exchangeDeclared(owner, exchange("source"))
        topology.queueDeclared(owner, "queue", {}, reply("queue"))
        yield* applyBinding(topology, owner, binding("queue"), false)
        topology.addConsumer(owner, "queue")
      }
      const events: Array<string> = []
      const bad = recorder(events, "failed")
      const good = recorder(events, "survivor")
      const errors: Array<{
        owner: object
        error: string
      }> = []
      let active = true
      yield* topology.restore([failed, survivor], (owner) => {
        if (owner === survivor) return good.restorer
        return active ? { ...bad.restorer, exchange: () => Effect.fail("exchange failed") } : undefined
      }, (owner, error) =>
        Effect.sync(() => {
          errors.push({ owner, error })
          active = false
        }))
      expect(errors).toEqual([{ owner: failed, error: "exchange failed" }])
      expect(events).toEqual([
        "survivor:exchange",
        "survivor:queue",
        "survivor:binding",
        "survivor:consumer",
        "survivor:ready"
      ])
    }))

  it.effect("snapshots nested dates, bytes, arrays and decimals before waiting for a declaration reply", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      const date = new Date(1000)
      const bytes = new Uint8Array([1, 2])
      const decimal = { _tag: "Decimal" as const, scale: 2, value: 123 }
      const nested = { label: "original", values: [date, bytes, decimal] }
      const options = { durable: true, arguments: { nested } }
      const snapshot = yield* DesiredTopology.snapshotOptions(options)
      const brokerReply = Effect.sync(() => {
        date.setTime(2000)
        bytes[0] = 9
        decimal.value = 999
        nested.label = "mutated"
        nested.values.push(new Date(3000))
        options.durable = false
        return reply("queue")
      })
      topology.queueDeclared(owner, "queue", snapshot, yield* brokerReply)
      const observed = recorder()
      yield* topology.restore([owner], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.queues).toEqual([{
        requested: "queue",
        options: {
          durable: true,
          arguments: {
            nested: {
              label: "original",
              values: [new Date(1000), new Uint8Array([1, 2]), { _tag: "Decimal", scale: 2, value: 123 }]
            }
          }
        }
      }])
      expect(snapshot.arguments.nested).not.toBe(nested)
    }))

  it.effect("copies Buffer views rather than retaining their mutable backing storage", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      const backing = Buffer.from([1, 2, 3, 4])
      const snapshot = yield* DesiredTopology.snapshotOptions({
        arguments: { nested: { bytes: backing.subarray(1, 3) } }
      })
      topology.queueDeclared(owner, "queue", snapshot, reply("queue"))
      backing.fill(9)
      const observed = recorder()
      yield* topology.restore([owner], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.queues).toEqual([{
        requested: "queue",
        options: { arguments: { nested: { bytes: new Uint8Array([2, 3]) } } }
      }])
    }))

  it.effect("keeps named references stable, anonymous declarations distinct and ephemeral status current", () =>
    Effect.gen(function*() {
      const topology = DesiredTopology.make<object, AMQPTopology.QueueName>()
      const owner = {}
      expect(topology.hasEphemeralQueues(owner)).toBe(false)
      const named = topology.queueDeclared(owner, "named", {}, reply("named"))
      const updated = topology.queueDeclared(owner, "named", { durable: true }, {
        queue: "named",
        messageCount: 3,
        consumerCount: 2
      })
      expect(updated).toBe(named)
      expect(named.messageCount).toBe(3)
      expect(named.consumerCount).toBe(2)
      expect(topology.hasEphemeralQueues(owner)).toBe(false)
      topology.queueDeclared(owner, "temporary", { autoDelete: true }, reply("temporary"))
      expect(topology.hasEphemeralQueues(owner)).toBe(true)
      topology.queueDeleted("temporary")
      expect(topology.hasEphemeralQueues(owner)).toBe(false)
      const first = topology.queueDeclared(owner, "", {}, reply("anonymous-first"))
      const second = topology.queueDeclared(owner, "", {}, reply("anonymous-second"))
      expect(first).not.toBe(second)
      expect(topology.hasEphemeralQueues(owner)).toBe(true)
      const observed = recorder()
      yield* topology.restore([owner], () => observed.restorer, (_owner, error) => Effect.fail(error))
      expect(observed.queues).toEqual([
        { requested: "named", options: { durable: true } },
        { requested: "", options: {} },
        { requested: "", options: {} }
      ])
      topology.queueDeleted(first)
      expect(topology.hasEphemeralQueues(owner)).toBe(false)
    }))
})
