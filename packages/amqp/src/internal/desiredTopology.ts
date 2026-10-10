import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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

const snapshotField = (value: AMQPTypes.FieldValue): AMQPTypes.FieldValue => {
  if (value === null || typeof value !== "object") return value
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof Date) return new Date(value.getTime())
  if (AMQPTypes.LongStringTypeId in value) {
    const longString = value as AMQPTypes.LongString
    return { ...longString, bytes: new Uint8Array(longString.bytes) }
  }
  if (AMQPTypes.DecimalTypeId in value) return { ...value }
  if (AMQPTypes.FieldNumberTypeId in value) return { ...value }
  if (Array.isArray(value)) return value.map(snapshotField)
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, snapshotField(field)]))
}

/** Snapshot before the network wait so caller mutation cannot change the desired declaration. */
const decodeSnapshotTable = Schema.decodeUnknownEffect(Protocol.fieldTable)
export const snapshotTable = Effect.fnUntraced(function*(table: AMQPTypes.FieldTable) {
  const value = yield* decodeSnapshotTable(table).pipe(
    Effect.mapError((cause) => new AMQPProtocolError({ reason: cause.message, cause }))
  )
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, snapshotField(field)]))
})

export const snapshotOptions = Effect.fnUntraced(function*<A extends { readonly arguments?: AMQPTypes.FieldTable }>(
  options: A
): Effect.fn.Return<A, AMQPProtocolError> {
  return {
    ...options,
    ...(options.arguments === undefined ? {} : { arguments: yield* snapshotTable(options.arguments) })
  }
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
export const make = <Owner extends object, Consumer>() => {
  const channels = new Map<Owner, Channel<Consumer>>()
  const argumentsKeys = new WeakMap<Binding, Uint8Array>()
  const channel = (owner: Owner): Channel<Consumer> => {
    let state = channels.get(owner)
    if (state === undefined) {
      state = { queues: [], exchanges: new Map(), bindings: [], consumers: new Set() }
      channels.set(owner, state)
    }
    return state
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
      } else {
        const state = channel(owner)
        if (!state.bindings.some(sameBinding)) {
          argumentsKeys.set(remembered, argumentsKey)
          state.bindings.push(remembered)
        }
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
    queueDeleted: (queue: AMQPTopology.QueueName): void => {
      const name = queueName(queue)
      for (const state of channels.values()) {
        removeWhere(state.queues, (item) => item.current.queue === name)
        removeWhere(state.bindings, (item) => item.queue !== undefined && queueName(item.queue) === name)
      }
    },
    exchangeDeleted: (exchange: string): void => {
      for (const state of channels.values()) {
        state.exchanges.delete(exchange)
        removeWhere(state.bindings, (item) => item.source === exchange || item.destination === exchange)
      }
    },
    consumers: (owner: Owner): ReadonlySet<Consumer> => channel(owner).consumers,
    addConsumer: (owner: Owner, consumer: Consumer): void => {
      channel(owner).consumers.add(consumer)
    },
    removeConsumer: (owner: Owner, consumer: Consumer): void => {
      channels.get(owner)?.consumers.delete(consumer)
    },
    hasEphemeralQueues: (owner: Owner, consumerQueue?: (consumer: Consumer) => AMQPTopology.QueueName): boolean => {
      const state = channels.get(owner)
      if (state === undefined) return false
      const dependencies = [
        ...(consumerQueue === undefined ? [] : Array.from(state.consumers, consumerQueue)),
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
      channels.delete(owner)
    },
    restore
  }
}
