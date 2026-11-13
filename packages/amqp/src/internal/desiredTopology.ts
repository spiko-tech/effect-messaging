import * as Effect from "effect/Effect"
import { AMQPProtocolError } from "../AMQPError.ts"
import * as AMQPTopology from "../AMQPTopology.ts"
import * as AMQPTypes from "../AMQPTypes.ts"
import * as Codec from "./codec.ts"
import * as Protocol from "./protocol.ts"

/** Desired declarations are configuration, never a history of commands. */
export interface ExchangeDeclaration {
  readonly exchange: string
  readonly type: string
  readonly options: AMQPTypes.ExchangeOptions
}

export interface Binding {
  readonly queue?: AMQPTopology.QueueName
  readonly destination?: string
  readonly source: string
  readonly routingKey: string
  readonly arguments: AMQPTypes.FieldTable
}

interface QueueDeclaration {
  readonly requested: string
  options: AMQPTypes.QueueOptions
  readonly reference: AMQPTopology.QueueReference
  current: AMQPTypes.QueueReply
}

interface Channel<Consumer> {
  readonly queues: Array<QueueDeclaration>
  readonly exchanges: Map<string, ExchangeDeclaration>
  readonly bindings: Array<Binding>
  readonly consumers: Set<Consumer>
}

/** Each restorer captures one live channel; transport and failure policy stay with its owner. */
export interface Restorer<Consumer, E> {
  readonly exchange: (declaration: ExchangeDeclaration) => Effect.Effect<void, E>
  readonly queue: (requested: string, options: AMQPTypes.QueueOptions) => Effect.Effect<AMQPTypes.QueueReply, E>
  readonly binding: (binding: Binding) => Effect.Effect<void, E>
  readonly consumer: (consumer: Consumer) => Effect.Effect<void, E>
  readonly ready: () => void
}

export const queueName = (queue: AMQPTopology.QueueName): string => typeof queue === "string" ? queue : queue.queue

/** Snapshot before the network wait so caller mutation cannot change the desired declaration. */
export const snapshotTable = Protocol.snapshotFieldTable

export const snapshotOptions = Effect.fnUntraced(function*<A extends { readonly arguments?: AMQPTypes.FieldTable }>(
  options: A
): Effect.fn.Return<A, AMQPProtocolError> {
  const copied = yield* Effect.try({
    try: () => ({ ...options }),
    catch: (cause) => new AMQPProtocolError({ reason: "Cannot snapshot topology options", cause })
  })
  return copied.arguments === undefined ? copied : { ...copied, arguments: yield* snapshotTable(copied.arguments) }
})

const canonicalField = (value: AMQPTypes.FieldValue): AMQPTypes.FieldValue => {
  if (value === null || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value
  if (Array.isArray(value)) return value.map(canonicalField)
  if (
    AMQPTypes.DecimalTypeId in value || AMQPTypes.FieldNumberTypeId in value || AMQPTypes.LongStringTypeId in value
  ) return value
  return canonicalTable(value as AMQPTypes.FieldTable)
}

const canonicalTable = (table: AMQPTypes.FieldTable): AMQPTypes.FieldTable =>
  Object.fromEntries(
    Object.entries(table).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(
      ([key, field]) => [key, canonicalField(field)]
    )
  )

const sameArguments = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false
  return true
}

const removeWhere = <A>(values: Array<A>, predicate: (value: A) => boolean): void => {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]
    if (value !== undefined && predicate(value)) values.splice(index, 1)
  }
}

/**
 * Owns the cross-channel desired graph, stable queue references, and restoration order.
 * Mutations are recorded only after successful broker replies. Removing an owner does not
 * delete broker resources or desired declarations held by other owners.
 */
export const make = <Owner extends object, Consumer>(consumerQueue: (consumer: Consumer) => AMQPTopology.QueueName) => {
  const channels = new Map<Owner, Channel<Consumer>>()
  const argumentsKeys = new WeakMap<Binding, Uint8Array>()
  const inherited = new WeakSet<object>()
  const channel = (owner: Owner): Channel<Consumer> => {
    let state = channels.get(owner)
    if (state === undefined) {
      state = { queues: [], exchanges: new Map(), bindings: [], consumers: new Set() }
      channels.set(owner, state)
    }
    return state
  }

  // Closed channels are never retained. Their configuration is assigned to live dependants,
  // but is not a new ownership root: the last dependency disappearing prunes it.
  const reconcile = (removed?: Channel<Consumer>): void => {
    const states = [...channels.values(), ...(removed === undefined ? [] : [removed])]
    if (removed !== undefined) {
      for (const node of [...removed.queues, ...removed.exchanges.values(), ...removed.bindings]) inherited.add(node)
    }
    const queues = states.flatMap((state) => state.queues)
    const exchanges = states.flatMap((state) => [...state.exchanges.values()])
    const bindings = states.flatMap((state) => state.bindings)
    const assigned = new Set<object>()
    const allocations = new Map<Channel<Consumer>, Set<object>>()
    for (const state of channels.values()) {
      const needed = new Set<object>()
      const names = new Set<string>()
      const queueDependencies = new Set<AMQPTopology.QueueName>(Array.from(state.consumers, consumerQueue))
      for (const node of [...state.queues, ...state.exchanges.values(), ...state.bindings]) {
        if (!inherited.has(node)) needed.add(node)
      }
      let changed = true
      while (changed) {
        const size = needed.size + names.size + queueDependencies.size
        for (const queue of queues) {
          if (
            Array.from(queueDependencies).some((name) =>
              name === queue.reference || queueName(name) === queue.current.queue
            )
          ) {
            needed.add(queue)
          }
          if (needed.has(queue)) queueDependencies.add(queue.reference)
        }
        for (const declaration of exchanges) {
          if (names.has(declaration.exchange)) needed.add(declaration)
          if (needed.has(declaration)) names.add(declaration.exchange)
        }
        for (const binding of bindings) {
          const destinationQueue = binding.queue
          // Retain upstream routing owned by a closed channel as well as explicit live bindings.
          if (
            inherited.has(binding) && (
              destinationQueue !== undefined
                ? Array.from(queueDependencies).some((queue) => queueName(queue) === queueName(destinationQueue))
                : binding.destination !== undefined && names.has(binding.destination)
            )
          ) needed.add(binding)
          if (needed.has(binding)) {
            names.add(binding.source)
            if (binding.destination !== undefined) names.add(binding.destination)
            if (binding.queue !== undefined) queueDependencies.add(binding.queue)
          }
        }
        changed = needed.size + names.size + queueDependencies.size !== size
      }
      allocations.set(state, new Set([...needed].filter((node) => inherited.has(node) && !assigned.has(node))))
      for (const node of needed) assigned.add(node)
    }
    for (const state of channels.values()) {
      removeWhere(state.queues, (node) => inherited.has(node))
      removeWhere(state.bindings, (node) => inherited.has(node))
      for (const [name, node] of state.exchanges) if (inherited.has(node)) state.exchanges.delete(name)
      const allocation = allocations.get(state)
      for (const queue of queues) if (allocation?.has(queue)) state.queues.push(queue)
      for (const declaration of exchanges) {
        if (allocation?.has(declaration) && !state.exchanges.has(declaration.exchange)) {
          state.exchanges.set(declaration.exchange, declaration)
        }
      }
      for (const binding of bindings) if (allocation?.has(binding)) state.bindings.push(binding)
    }
  }

  const queueDeclared = (
    owner: Owner,
    requested: string,
    options: AMQPTypes.QueueOptions,
    reply: AMQPTypes.QueueReply
  ): AMQPTopology.QueueReference => {
    const state = channel(owner)
    const previous = requested === "" ? undefined : state.queues.find((item) => item.requested === requested)
    if (previous !== undefined) {
      inherited.delete(previous)
      previous.current = reply
      previous.options = options
      return previous.reference
    }
    let current = reply
    const declaration: QueueDeclaration = {
      requested,
      options,
      get current() {
        return current
      },
      set current(value) {
        current = value
      },
      reference: {
        [AMQPTopology.QueueTypeId]: AMQPTopology.QueueTypeId,
        get queue() {
          return current.queue
        },
        get messageCount() {
          return current.messageCount
        },
        get consumerCount() {
          return current.consumerCount
        }
      }
    }
    state.queues.push(declaration)
    return declaration.reference
  }

  // Run preparation before the RPC. Commit only after its successful reply; it uses only
  // prepared values and performs the complete desired-state mutation synchronously.
  const prepareBinding = Effect.fnUntraced(function*(owner: Owner, binding: Binding, remove: boolean) {
    const snapshot = yield* snapshotTable(binding.arguments)
    const argumentsKey = yield* Codec.encodeFieldTable(canonicalTable(snapshot))
    const remembered: Binding = { ...binding, arguments: snapshot }
    // Encoding may yield; the returned mutation must not yield after a successful broker reply.
    const commit = () => {
      const sameBinding = (item: Binding) => {
        const previous = argumentsKeys.get(item)
        return previous !== undefined && (
          item.queue === undefined ? remembered.queue === undefined : remembered.queue !== undefined &&
            (remove ? queueName(item.queue) === queueName(remembered.queue) : item.queue === remembered.queue)
        ) && item.destination === remembered.destination && item.source === remembered.source &&
          item.routingKey === remembered.routingKey && sameArguments(previous, argumentsKey)
      }
      if (remove) {
        for (const state of channels.values()) removeWhere(state.bindings, sameBinding)
        reconcile()
      } else {
        const state = channel(owner)
        const previous = state.bindings.find(sameBinding)
        if (previous === undefined) {
          argumentsKeys.set(remembered, argumentsKey)
          state.bindings.push(remembered)
        } else inherited.delete(previous)
      }
    }
    return { binding: remembered, commit }
  })

  const restore = <E>(
    owners: ReadonlyArray<Owner>,
    restorer: (owner: Owner) => Restorer<Consumer, E> | undefined,
    onError: (owner: Owner, error: E) => Effect.Effect<void, E>
  ): Effect.Effect<void, E> =>
    Effect.gen(function*() {
      // Every channel completes declarations before any channel starts dependent bindings or consumers.
      for (const phase of ["Exchanges", "Queues", "Bindings", "Consumers"] as const) {
        for (const owner of owners) {
          const run = Effect.gen(function*() {
            const state = channels.get(owner)
            const target = restorer(owner)
            if (target === undefined) return
            if (phase === "Exchanges") {
              for (const declaration of state?.exchanges.values() ?? []) yield* target.exchange(declaration)
            } else if (phase === "Queues") {
              for (const declaration of state?.queues ?? []) {
                declaration.current = yield* target.queue(declaration.requested, declaration.options)
              }
            } else if (phase === "Bindings") {
              for (const binding of state?.bindings ?? []) yield* target.binding(binding)
            } else {
              for (const consumer of state?.consumers ?? []) yield* target.consumer(consumer)
              target.ready()
            }
          })
          yield* run.pipe(Effect.catch((error) => onError(owner, error)))
        }
      }
    })

  return {
    queueDeclared,
    exchangeDeclared: (owner: Owner, declaration: ExchangeDeclaration): void => {
      channel(owner).exchanges.set(declaration.exchange, declaration)
    },
    prepareBinding,
    // After DeleteOk, retire the returned registrations locally; the broker queue is
    // already gone, so neither consumer cleanup nor recovery should issue basic.cancel.
    queueDeleted: (queue: AMQPTopology.QueueName): ReadonlyArray<Consumer> => {
      const name = queueName(queue)
      const cancelled = new Set<Consumer>()
      for (const state of channels.values()) {
        for (const consumer of state.consumers) {
          if (queueName(consumerQueue(consumer)) === name) {
            state.consumers.delete(consumer)
            cancelled.add(consumer)
          }
        }
        removeWhere(state.queues, (item) => item.current.queue === name)
        removeWhere(state.bindings, (item) => item.queue !== undefined && queueName(item.queue) === name)
      }
      reconcile()
      return [...cancelled]
    },
    exchangeDeleted: (exchange: string): void => {
      for (const state of channels.values()) {
        state.exchanges.delete(exchange)
        removeWhere(state.bindings, (item) => item.source === exchange || item.destination === exchange)
      }
      reconcile()
    },
    consumers: (owner: Owner): ReadonlySet<Consumer> => channel(owner).consumers,
    addConsumer: (owner: Owner, consumer: Consumer): void => {
      channel(owner).consumers.add(consumer)
    },
    removeConsumer: (owner: Owner, consumer: Consumer): void => {
      channels.get(owner)?.consumers.delete(consumer)
      reconcile()
    },
    hasEphemeralQueues: (owner: Owner): boolean => {
      const state = channels.get(owner)
      if (state === undefined) return false
      const dependencies = [
        ...Array.from(state.consumers, consumerQueue),
        ...state.bindings.flatMap((binding) => binding.queue === undefined ? [] : [binding.queue])
      ]
      for (const candidate of channels.values()) {
        for (const queue of candidate.queues) {
          if (
            (queue.requested === "" || queue.options.autoDelete === true) &&
            (candidate === state || dependencies.some((dependency) => queueName(dependency) === queue.current.queue))
          ) return true
        }
      }
      return false
    },
    remove: (owner: Owner): void => {
      const state = channels.get(owner)
      channels.delete(owner)
      reconcile(state)
    },
    restore
  }
}
