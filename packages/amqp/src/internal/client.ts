import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type * as AMQPChannel from "../AMQPChannel.ts"
import type * as AMQPConnection from "../AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../AMQPConsumeMessage.ts"
import * as AMQPError from "../AMQPError.ts"
import type * as AMQPTopology from "../AMQPTopology.ts"
import type * as AMQPTypes from "../AMQPTypes.ts"
import * as Codec from "./codec.ts"
import * as DeliverySettlement from "./deliverySettlement.ts"
import * as DesiredTopology from "./desiredTopology.ts"
import * as Protocol from "./protocol.ts"
import { ChannelTypeId, ConnectionTypeId } from "./typeIds.ts"

type Error = AMQPError.AMQPError
type Fields = Record<string, AMQPTypes.FieldValue>
type Message = AMQPConsumeMessage.AMQPConsumeMessage

const isContent = Schema.is(Schema.Uint8Array)

interface Reply {
  readonly method: Codec.Method
  readonly message?: Message
}

interface Pending {
  readonly expected: ReadonlyArray<Protocol.MethodDescriptor>
  readonly done: Deferred.Deferred<Reply, Error>
}

interface Write {
  readonly frames: Array<Uint8Array>
  readonly bytes: number
  readonly done: Deferred.Deferred<void, Error>
  readonly drained: Deferred.Deferred<void>
  readonly publish: boolean
  readonly priority: boolean
  readonly channel: number
  readonly physical?: Physical
  started: boolean
  cancelled: boolean
}

interface PublishAdmission {
  readonly command: Write
  readonly confirm: Deferred.Deferred<void, Error> | undefined
}

interface Envelope<A> {
  readonly value: A
  readonly physical: Physical
  readonly release: () => void
}

interface Consumer {
  readonly queue: AMQPTopology.QueueName
  readonly options: AMQPTypes.ConsumeOptions
  readonly mailbox: Queue.Queue<Envelope<Message>, Error | Cause.Done>
  tag: string
  active: boolean
}

interface Logical {
  readonly options: AMQPChannel.AMQPChannelOptions
  readonly ready: Latch.Latch
  readonly closeDone: Deferred.Deferred<void>
  readonly operations: Semaphore.Semaphore
  readonly returned: Queue.Queue<Envelope<AMQPTypes.ReturnedMessage>, Error | Cause.Done>
  physical: Physical | undefined
  closed: boolean
  error: Error | undefined
  prefetch: number
  globalPrefetch: number | undefined
  pendingOperations: number
}

interface Content {
  readonly method: Codec.Method
  properties: AMQPTypes.MessageProperties | undefined
  body: Uint8Array | undefined
  offset: number
  release: (() => void) | undefined
}

interface Physical {
  readonly id: number
  readonly epoch: Epoch
  readonly logical: Logical
  readonly rpc: Semaphore.Semaphore
  readonly publishing: Semaphore.Semaphore
  readonly flow: Latch.Latch
  readonly confirmCapacity: Latch.Latch
  readonly admissionClosed: Deferred.Deferred<void>
  readonly confirms: Map<bigint, Deferred.Deferred<void, Error>>
  readonly consumers: Map<string, Consumer>
  active: boolean
  closing: boolean
  pending: Pending | undefined
  content: Content | undefined
  sequence: bigint
}

interface Epoch {
  readonly generation: number
  readonly scope: Scope.Scope
  readonly writer: Socket.Writer
  readonly failure: Deferred.Deferred<never, AMQPError.AMQPConnectionError>
  readonly wakeWriter: Latch.Latch
  readonly publishGate: Latch.Latch
  readonly control: Array<Write>
  readonly data: Array<Write>
  readonly channels: Map<number, Physical>
  readonly freeChannels: Array<number>
  readonly rpc: Semaphore.Semaphore
  active: boolean
  nextChannel: number
  pending: Pending | undefined
  writing: Write | undefined
  outboundBytes: number
  outboundCommands: number
  bufferedBytes: number
  frameMax: number
  channelMax: number
  heartbeat: number
  heartbeatWrite: Write | undefined
  lastRead: number
  lastWrite: number
  serverProperties: AMQPTypes.FieldTable
  brokerCloseError: AMQPError.AMQPConnectionError | undefined
  blocked: string | undefined
}

const connectionError = (reason: string, cause?: unknown, permanent = false) =>
  new AMQPError.AMQPConnectionError({ reason, cause, permanent })
const channelError = (reason: string, cause?: unknown) => new AMQPError.AMQPChannelError({ reason, cause })
const protocolError = (cause: unknown): AMQPError.AMQPProtocolError =>
  cause instanceof AMQPError.AMQPProtocolError
    ? cause
    : new AMQPError.AMQPProtocolError({ reason: "Invalid AMQP wire data", cause })
const publishError = (outcome: "NotSent" | "Unknown" | "Nacked", reason: string, cause?: unknown) =>
  new AMQPError.AMQPPublishError({ outcome, reason, cause })
const finish = <A, E>(deferred: Deferred.Deferred<A, E>, effect: Effect.Effect<A, E>): void => {
  Deferred.doneUnsafe(deferred, effect)
}
const combineReleases = (first: (() => void) | undefined, second: () => void): () => void => {
  return () => {
    first?.()
    second()
  }
}
const integer = (name: string, value: number, minimum: number, maximum: number) =>
  Schema.decodeUnknownEffect(Schema.Int.check(Schema.isBetween({ minimum, maximum })))(value).pipe(
    Effect.mapError((cause) => channelError(`${name} must be an integer from ${minimum} to ${maximum}`, cause))
  )
const wire = <A>(thunk: () => A): Effect.Effect<A, AMQPError.AMQPProtocolError> =>
  Effect.try({ try: thunk, catch: protocolError })

// Queue.takeUnsafe never waits. This is used on retirement, not on the application read path.
const discard = <A>(mailbox: Queue.Queue<Envelope<A>, Error | Cause.Done>): void => {
  while (true) {
    const item = Queue.takeUnsafe(mailbox)
    if (item === undefined || Exit.isFailure(item)) return
    item.value.release()
  }
}

const mailboxStream = <A>(mailbox: Queue.Queue<Envelope<A>, Error | Cause.Done>): Stream.Stream<A, Error> =>
  Stream.fromEffectRepeat(Queue.take(mailbox)).pipe(
    Stream.filter((envelope) => {
      envelope.release()
      return envelope.physical.active && envelope.physical.epoch.active
    }),
    Stream.map((envelope) => envelope.value)
  )

/** @internal */
export const make = <R>(
  socketFactory: AMQPConnection.SocketFactory<R>,
  options: AMQPConnection.AMQPConnectionOptions
): Effect.Effect<AMQPConnection.AMQPConnection, Error, Scope.Scope | R> =>
  Effect.gen(function*() {
    options = {
      ...options,
      ...(options.clientProperties === undefined ? {} : {
        clientProperties: yield* DesiredTopology.snapshotTable(options.clientProperties ?? {})
      })
    }
    const scope = yield* Effect.scope
    const maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024
    const maxBufferedBytes = options.maxBufferedBytes ?? 64 * 1024 * 1024
    const maxOutboundBytes = options.maxOutboundBytes ?? 32 * 1024 * 1024
    const maxPending = options.maxPendingOperations ?? 1024
    const requestedFrameMax = options.frameMax ?? 131072
    const requestedChannelMax = options.channelMax ?? 0
    const requestedHeartbeat = options.heartbeat ?? 60
    const connectionTimeout = options.connectionTimeout ?? "10 seconds"
    const waitConnectionTimeout = options.waitConnectionTimeout ?? "10 seconds"
    const shutdownTimeout = options.shutdownTimeout ?? "5 seconds"
    const validate = Effect.gen(function*() {
      yield* integer("heartbeat", requestedHeartbeat, 0, 65535)
      yield* integer("channelMax", requestedChannelMax, 0, 65535)
      yield* integer("frameMax", requestedFrameMax, 0, 0xffffffff)
      if (requestedFrameMax !== 0 && requestedFrameMax < 4096) {
        return yield* channelError("frameMax must be zero or at least 4096")
      }
      yield* integer("maxMessageBytes", maxMessageBytes, 1, 0x7fffffff)
      yield* integer("maxBufferedBytes", maxBufferedBytes, 4096, 0x7fffffff)
      yield* integer("maxOutboundBytes", maxOutboundBytes, 4096, 0x7fffffff)
      yield* integer("maxPendingOperations", maxPending, 1, 65535)
    })
    yield* validate.pipe(Effect.mapError((error) => connectionError(error.reason, error, true)))

    const state = yield* SubscriptionRef.make<AMQPConnection.ConnectionState>({ state: "Connecting", generation: 0 })
    const ready = Latch.makeUnsafe()
    const closeDone = Deferred.makeUnsafe<void>()
    const logicals = new Set<Logical>()
    const topology = DesiredTopology.make<Logical, Consumer>()
    const settlements = DeliverySettlement.make<Message, Physical, Logical>({
      ownerOf: (origin) => origin.logical,
      isActive: (origin) => origin.active && origin.epoch.active && !origin.logical.closed
    })
    let current: Epoch | undefined
    let brokerClosing: Epoch | undefined
    let generation = 0
    let closing = false
    let terminal: Error | undefined
    let secret = options.password ?? "guest"
    let connection: AMQPConnection.AMQPConnection

    const setState = (value: AMQPConnection.ConnectionState) => SubscriptionRef.set(state, value)

    const failEpoch = (epoch: Epoch, error: AMQPError.AMQPConnectionError): void => {
      if (!epoch.active) return
      error = epoch.brokerCloseError ?? error
      // Invalidate immediately, before any scoped fiber is interrupted or a replacement socket is acquired.
      epoch.active = false
      if (current === epoch) current = undefined
      if (brokerClosing === epoch) brokerClosing = undefined
      ready.closeUnsafe()
      epoch.publishGate.openUnsafe()
      epoch.wakeWriter.openUnsafe()
      if (epoch.pending !== undefined) finish(epoch.pending.done, Effect.fail(error))
      for (const physical of epoch.channels.values()) retirePhysical(physical, error)
      for (
        const command of [...epoch.control, ...epoch.data, ...(epoch.writing === undefined ? [] : [epoch.writing])]
      ) {
        finish(
          command.done,
          Effect.fail(
            command.publish
              ? publishError(command.started ? "Unknown" : "NotSent", "Connection lost during publish", error)
              : error
          )
        )
      }
      epoch.control.length = 0
      epoch.data.length = 0
      finish(epoch.failure, Effect.fail(error))
    }

    const awaitBrokerClose = (epoch: Epoch) =>
      Effect.suspend(() =>
        epoch.active && epoch.brokerCloseError !== undefined
          ? Deferred.await(epoch.failure).pipe(Effect.ignore)
          : Effect.void
      )

    const retirePhysical = (physical: Physical, error: Error): void => {
      if (!physical.active) return
      physical.active = false
      physical.closing = true
      finish(physical.admissionClosed, Effect.void)
      physical.flow.openUnsafe()
      physical.confirmCapacity.openUnsafe()
      physical.logical.ready.closeUnsafe()
      if (physical.logical.physical === physical) physical.logical.physical = undefined
      if (physical.pending !== undefined) finish(physical.pending.done, Effect.fail(error))
      for (const confirm of physical.confirms.values()) {
        finish(confirm, Effect.fail(publishError("Unknown", "Channel lost before broker confirmation", error)))
      }
      physical.confirms.clear()
      settlements.retire(physical)
      physical.consumers.clear()
      const epoch = physical.epoch
      for (
        const command of [...epoch.control, ...epoch.data, ...(epoch.writing === undefined ? [] : [epoch.writing])]
      ) {
        if (command.physical !== physical) continue
        if (!command.started) command.cancelled = true
        finish(
          command.done,
          Effect.fail(
            command.publish
              ? publishError(command.started ? "Unknown" : "NotSent", "Channel retired during publish", error)
              : error
          )
        )
      }
      physical.content?.release?.()
      physical.content = undefined
      for (const consumer of topology.consumers(physical.logical)) discard(consumer.mailbox)
      discard(physical.logical.returned)
    }

    const failLogical = (logical: Logical, error: Error): void => {
      logical.error = error
      if (logical.physical !== undefined) retirePhysical(logical.physical, error)
      logical.ready.openUnsafe()
      for (const consumer of topology.consumers(logical)) {
        discard(consumer.mailbox)
        Queue.failCauseUnsafe(consumer.mailbox, Cause.fail(error))
      }
      discard(logical.returned)
      Queue.failCauseUnsafe(logical.returned, Cause.fail(error))
    }

    const stop = (error: Error) =>
      Effect.sync(() => {
        terminal = error
        ready.openUnsafe()
        for (const logical of logicals) failLogical(logical, error)
      })

    const awaitEpoch = Effect.gen(function*() {
      yield* ready.await
      if (terminal !== undefined) return yield* Effect.fail(terminal)
      if (closing) return yield* connectionError("Connection is closed", undefined, true)
      if (current === undefined || !current.active) return yield* connectionError("Connection is not ready")
      return current
    }).pipe(
      Effect.timeout(waitConnectionTimeout),
      Effect.catchTag("TimeoutError", () => Effect.fail(connectionError("Timed out waiting for connection readiness")))
    )

    const awaitPhysical = (logical: Logical) =>
      Effect.gen(function*() {
        yield* logical.ready.await
        if (logical.error !== undefined) return yield* Effect.fail(logical.error)
        if (logical.closed || closing) return yield* channelError("Channel is closed")
        const physical = logical.physical
        if (physical === undefined || !physical.active || !physical.epoch.active) {
          return yield* channelError("Channel is not ready")
        }
        return physical
      }).pipe(
        Effect.timeout(logical.options.waitChannelTimeout ?? "10 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(channelError("Timed out waiting for channel readiness")))
      )

    const encodeMethodFrame = (epoch: Epoch, channel: number, method: Protocol.MethodDescriptor, fields: Fields = {}) =>
      Codec.encodeMethod(channel, method, fields).pipe(Effect.flatMap((frame) =>
        frame.byteLength > epoch.frameMax
          ? Effect.fail(new AMQPError.AMQPProtocolError({ reason: "Encoded frame exceeds negotiated frameMax" }))
          : Effect.succeed(frame)
      ))

    const submit = (
      epoch: Epoch,
      frames: Array<Uint8Array>,
      publish = false,
      physical?: Physical,
      priority = false,
      onAdmitted?: () => void
    ): Result.Result<Write, Error> => {
      if (
        !epoch.active || (epoch.brokerCloseError !== undefined && !priority) ||
        (physical !== undefined && !physical.active)
      ) {
        return Result.fail(
          publish
            ? publishError("NotSent", "Session retired before write admission")
            : connectionError("Session retired before write admission")
        )
      }
      const first = frames[0]
      if (first === undefined) return Result.fail(new AMQPError.AMQPProtocolError({ reason: "Empty outbound command" }))
      let bytes = 0
      for (const frame of frames) {
        if (frame.byteLength > epoch.frameMax) {
          return Result.fail(new AMQPError.AMQPProtocolError({ reason: "Encoded frame exceeds negotiated frameMax" }))
        }
        bytes += frame.byteLength
      }
      const channel = first === Codec.PROTOCOL_HEADER
        ? 0
        : new DataView(first.buffer, first.byteOffset, first.byteLength).getUint16(1)
      // A small separately bounded reserve keeps flow, close and settlement controls admissible under publish load.
      const commandLimit = maxPending + (priority ? 16 : 0)
      const byteLimit = maxOutboundBytes + (priority ? 65536 : 0)
      if (epoch.outboundCommands >= commandLimit || epoch.outboundBytes + bytes > byteLimit) {
        return Result.fail(
          publish
            ? publishError("NotSent", "Outbound admission limit exceeded")
            : channelError("Outbound admission limit exceeded")
        )
      }
      const command: Write = {
        frames,
        bytes,
        done: Deferred.makeUnsafe(),
        drained: Deferred.makeUnsafe(),
        publish,
        priority,
        channel,
        ...(physical === undefined ? {} : { physical }),
        started: false,
        cancelled: false
      }
      epoch.outboundBytes += bytes
      epoch.outboundCommands++
      const commands = priority ? epoch.control : epoch.data
      commands.push(command)
      // A transport writer can resume synchronously and feed a broker response back into the reader.
      // Publish/settlement state must be installed before exposing this admitted command to that writer.
      onAdmitted?.()
      epoch.wakeWriter.openUnsafe()
      return Result.succeed(command)
    }

    const enqueue = Effect.fnUntraced(function*(
      epoch: Epoch,
      frames: Array<Uint8Array>,
      publish = false,
      physical?: Physical,
      priority = false,
      onAdmitted?: () => void
    ): Effect.fn.Return<void, Error> {
      const command = yield* Effect.suspend(() =>
        Effect.fromResult(submit(epoch, frames, publish, physical, priority, onAdmitted))
      )
      return yield* Deferred.await(command.done).pipe(Effect.onInterrupt(() =>
        Effect.sync(() => {
          // The writer, not the caller, owns a complete content sequence after admission.
          if (!command.started) command.cancelled = true
        })
      ))
    })

    const sendMethod = (
      epoch: Epoch,
      channel: number,
      method: Protocol.MethodDescriptor,
      fields: Fields = {},
      priority = false
    ) =>
      encodeMethodFrame(epoch, channel, method, fields).pipe(
        Effect.flatMap((frame) => enqueue(epoch, [frame], false, epoch.channels.get(channel), priority))
      )

    // The reader never waits for transport backpressure while acknowledging broker controls.
    const sendControl = (epoch: Epoch, channel: number, method: Protocol.MethodDescriptor, fields: Fields = {}) =>
      Codec.encodeMethod(channel, method, fields).pipe(
        Effect.flatMap((frame) =>
          Effect.suspend(() => Effect.fromResult(submit(epoch, [frame], false, undefined, true)))
        )
      )

    const writerLoop = Effect.fnUntraced(function*(epoch: Epoch): Effect.fn.Return<void> {
      while (epoch.active) {
        let command = epoch.control.shift()
        if (command === undefined) {
          const index = epoch.data.findIndex((item) =>
            !item.publish || item.cancelled ||
            item.physical?.active === false || (epoch.publishGate.isOpen() && (item.physical?.flow.isOpen() ?? true))
          )
          if (index >= 0) command = epoch.data.splice(index, 1)[0]
        }
        if (command === undefined) {
          epoch.wakeWriter.closeUnsafe()
          yield* epoch.wakeWriter.await
          continue
        }
        epoch.writing = command
        let completion: Effect.Effect<void, Error> = Effect.void
        if (
          command.cancelled || (epoch.brokerCloseError !== undefined && !command.priority) ||
          (command.physical !== undefined && !command.physical.active)
        ) {
          completion = Effect.fail(
            command.publish
              ? publishError("NotSent", "Publish cancelled before transport write")
              : channelError("Channel retired before transport write")
          )
        } else {
          command.started = true
          // Only this fiber writes. A caller cannot interrupt a partially written content sequence.
          const result = yield* Effect.exit(Effect.forEach(command.frames, (frame) =>
            Effect.suspend((): Effect.Effect<void, Socket.SocketError | AMQPError.AMQPChannelError> => {
              if (!epoch.active || command.physical?.active === false) {
                return Effect.fail(channelError("Write session retired"))
              }
              return epoch.writer.write(frame)
            }), {
            discard: true
          }))
          if (Exit.isFailure(result)) {
            if (command.physical?.active === false && epoch.active) {
              completion = Effect.fail(
                command.publish
                  ? publishError("Unknown", "Channel retired while content was being written", result.cause)
                  : channelError("Channel retired while method was being written", result.cause)
              )
            } else failEpoch(epoch, connectionError("Transport write failed", result.cause))
          } else {
            epoch.lastWrite = yield* Clock.currentTimeMillis
          }
        }
        epoch.outboundBytes -= command.bytes
        epoch.outboundCommands--
        epoch.writing = undefined
        finish(command.drained, Effect.void)
        // A completed waiter may immediately submit its next command. Release this write's reservation
        // first so sequential operations do not spuriously exceed a one-command admission limit.
        finish(command.done, completion)
      }
    })

    const reclaimPhysical = Effect.fnUntraced(function*(physical: Physical): Effect.fn.Return<void> {
      const epoch = physical.epoch
      retirePhysical(physical, channelError("Channel closed"))
      // A close-ok is the protocol barrier. Also drain local RPC ownership and every old write before reuse.
      yield* physical.rpc.withPermit(Effect.gen(function*() {
        if (!epoch.active || epoch.channels.get(physical.id) !== physical) {
          return
        }
        for (const commands of [epoch.control, epoch.data]) {
          for (let index = commands.length - 1; index >= 0; index--) {
            const command = commands[index]
            if (command === undefined || command.channel !== physical.id) {
              continue
            }
            commands.splice(index, 1)
            epoch.outboundBytes -= command.bytes
            epoch.outboundCommands--
            command.cancelled = true
            finish(
              command.done,
              Effect.fail(
                command.publish
                  ? publishError("NotSent", "Channel closed before queued publish was written")
                  : channelError("Channel closed before queued control was written")
              )
            )
            finish(command.drained, Effect.void)
          }
        }
        const writing = epoch.writing
        if (writing?.channel === physical.id) {
          yield* Deferred.await(writing.drained)
        }
        if (!epoch.active || epoch.channels.get(physical.id) !== physical) {
          return
        }
        epoch.channels.delete(physical.id)
        epoch.freeChannels.push(physical.id)
      }))
    })

    const rpc = Effect.fnUntraced(function*(
      epoch: Epoch,
      physical: Physical | undefined,
      method: Protocol.MethodDescriptor,
      fields: Fields,
      timeout: Duration.Input = connectionTimeout,
      onAdmitted?: () => void
    ): Effect.fn.Return<Reply, Error> {
      // Reject local encoding and size errors before a pending reply slot is installed.
      const frame = yield* encodeMethodFrame(epoch, physical?.id ?? 0, method, fields)
      const mutex = physical?.rpc ?? epoch.rpc
      return yield* mutex.withPermit(Effect.gen(function*() {
        if (!epoch.active || (physical !== undefined && !physical.active)) {
          return yield* connectionError("Session retired before RPC admission")
        }
        // Logical shutdown still lets already queued RPC owners drain. The wire close admission,
        // not logical.closed or the start of close encoding, is the barrier for ordinary methods.
        if (physical?.closing === true && method !== Protocol.ChannelClose) {
          return yield* channelError("Channel closing before RPC admission")
        }
        const pending: Pending = { expected: method.replies, done: Deferred.makeUnsafe() }
        if (physical === undefined) {
          epoch.pending = pending
        } else physical.pending = pending
        let admitted = false
        const operation = enqueue(epoch, [frame], false, physical, false, () => {
          admitted = true
          if (physical !== undefined && method === Protocol.ChannelClose) physical.closing = true
          onAdmitted?.()
        }).pipe(
          Effect.andThen(Deferred.await(pending.done)),
          Effect.timeout(timeout),
          Effect.catchTag("TimeoutError", () => {
            const error = epoch.brokerCloseError ?? connectionError(`Timed out waiting for ${method.name}`)
            if (admitted && epoch.brokerCloseError === undefined) {
              failEpoch(epoch, error)
            }
            return Effect.fail(error)
          }),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (admitted && epoch.brokerCloseError === undefined) {
                failEpoch(epoch, connectionError(`RPC ${method.name} interrupted after admission`))
              }
            })
          )
        )
        return yield* operation.pipe(Effect.ensuring(Effect.sync(() => {
          if (physical === undefined) {
            if (epoch.pending === pending) {
              epoch.pending = undefined
            }
          } else if (physical.pending === pending) {
            physical.pending = undefined
          }
        })))
      }))
    })

    const completeReply = Effect.fnUntraced(
      function*(pending: Pending | undefined, method: Codec.Method, message?: Message) {
        const descriptor = yield* Protocol.lookup(method.classId, method.methodId)
        if (
          pending === undefined || Deferred.isDoneUnsafe(pending.done) ||
          !pending.expected.includes(descriptor)
        ) {
          return yield* new AMQPError.AMQPProtocolError({
            reason: `Unexpected reply ${method.classId}.${method.methodId}`
          })
        }
        finish(pending.done, Effect.succeed({ method, ...(message === undefined ? {} : { message }) }))
      }
    )

    const reserve = (physical: Physical, bytes: number, onReserved: (release: () => void) => void) =>
      Effect.suspend(() => {
        const epoch = physical.epoch
        if (!epoch.active || !physical.active) {
          return Effect.fail(new AMQPError.AMQPProtocolError({ reason: "Session retired before content reservation" }))
        }
        if (epoch.bufferedBytes + bytes > maxBufferedBytes) {
          return Effect.fail(new AMQPError.AMQPProtocolError({ reason: "Inbound content memory limit exceeded" }))
        }
        epoch.bufferedBytes += bytes
        let released = false
        const release = () => {
          if (released) {
            return
          }
          released = true
          epoch.bufferedBytes -= bytes
        }
        onReserved(release)
        return Effect.succeed(release)
      })

    const requeueBufferedConsumer = Effect.fnUntraced(function*(consumer: Consumer) {
      const batches = new Map<Physical, Array<Uint8Array>>()
      while (true) {
        const envelope = Queue.takeUnsafe(consumer.mailbox)
        if (envelope === undefined || Exit.isFailure(envelope)) {
          break
        }
        envelope.value.release()
        const capability = settlements.revoke(envelope.value.value)
        if (capability === undefined) {
          continue
        }
        const physical = capability.origin
        if (!physical.active || !physical.epoch.active || physical.logical.closed || closing) {
          continue
        }
        const frames = batches.get(physical) ?? []
        const encoded = yield* Effect.result(
          Codec.encodeMethod(physical.id, Protocol.BasicReject, { deliveryTag: capability.tag, requeue: true })
        )
        if (Result.isFailure(encoded)) {
          failEpoch(physical.epoch, connectionError("Failed to encode buffered delivery rejection", encoded.failure))
          continue
        }
        frames.push(encoded.success)
        batches.set(physical, frames)
      }
      for (const [physical, frames] of batches) {
        // Only mailbox-resident deliveries are revoked. Messages already handed to application handlers
        // retain their original settlement capability, including after a broker-initiated consumer cancel.
        const admitted = submit(physical.epoch, frames, false, physical, true)
        if (Result.isFailure(admitted)) {
          failEpoch(
            physical.epoch,
            connectionError("Failed to requeue cancelled consumer's buffered deliveries", admitted.failure)
          )
        }
      }
    })

    const deliverContent = Effect.fnUntraced(function*(physical: Physical): Effect.fn.Return<void, Error> {
      if (!physical.active || !physical.epoch.active) return
      const content = physical.content
      if (content?.body === undefined || content.properties === undefined || content.release === undefined) {
        return yield* new AMQPError.AMQPProtocolError({ reason: "Content completed without header" })
      }
      const method = content.method
      const descriptor = yield* Protocol.lookup(method.classId, method.methodId)
      if (descriptor === Protocol.BasicReturn) {
        const value: AMQPTypes.ReturnedMessage = {
          content: content.body,
          properties: content.properties,
          fields: {
            replyCode: yield* Protocol.readNumber(method, "replyCode"),
            replyText: yield* Protocol.readString(method, "replyText"),
            exchange: yield* Protocol.readString(method, "exchange"),
            routingKey: yield* Protocol.readString(method, "routingKey")
          }
        }
        if (!physical.active || !physical.epoch.active) return
        physical.content = undefined
        if (!Queue.offerUnsafe(physical.logical.returned, { value, physical, release: content.release })) {
          content.release()
          return yield* new AMQPError.AMQPProtocolError({ reason: "Returned-message mailbox overflow" })
        }
        return
      }
      const tag = yield* Protocol.readBigInt(method, "deliveryTag")
      const value: Message = {
        content: content.body,
        properties: content.properties,
        fields: {
          consumerTag: descriptor === Protocol.BasicDeliver ? yield* Protocol.readString(method, "consumerTag") : "",
          deliveryTag: tag,
          redelivered: method.fields.redelivered === true,
          exchange: yield* Protocol.readString(method, "exchange"),
          routingKey: yield* Protocol.readString(method, "routingKey"),
          ...(descriptor === Protocol.BasicGetOk
            ? { messageCount: yield* Protocol.readNumber(method, "messageCount") }
            : {})
        }
      }
      if (!physical.active || !physical.epoch.active) return
      yield* Effect.fromResult(settlements.register(physical, value, tag))
      if (!physical.active || !physical.epoch.active) return
      physical.content = undefined
      if (descriptor === Protocol.BasicGetOk) {
        content.release()
        yield* completeReply(physical.pending, method, value)
        return
      }
      const consumer = physical.consumers.get(value.fields.consumerTag)
      if (consumer === undefined) {
        content.release()
        return yield* new AMQPError.AMQPProtocolError({ reason: "Delivery for unknown consumer" })
      }
      if (!consumer.active) {
        content.release()
        settlements.revoke(value)
        const frame = yield* Codec.encodeMethod(physical.id, Protocol.BasicReject, { deliveryTag: tag, requeue: true })
        yield* Effect.suspend(() => Effect.fromResult(submit(physical.epoch, [frame], false, physical, true)))
        return
      }
      if (!Queue.offerUnsafe(consumer.mailbox, { value, physical, release: content.release })) {
        content.release()
        return yield* new AMQPError.AMQPProtocolError({ reason: "Consumer mailbox overflow" })
      }
    })

    const openPhysical = Effect.fnUntraced(
      function*(epoch: Epoch, logical: Logical): Effect.fn.Return<Physical, Error> {
        if (logical.closed || closing) {
          return yield* channelError("Channel closed before recovery")
        }
        const reusable = epoch.freeChannels.pop()
        if (reusable === undefined && epoch.nextChannel > epoch.channelMax) {
          const hasRetiredChannel = Array.from(epoch.channels.values()).some((physical) => !physical.active)
          if (hasRetiredChannel) {
            const error = connectionError("Channel number space requires a fresh protocol session")
            failEpoch(epoch, error)
            return yield* error
          }
          return yield* channelError("Negotiated simultaneous channel limit exhausted")
        }
        const physical: Physical = {
          id: reusable ?? epoch.nextChannel++,
          epoch,
          logical,
          rpc: Semaphore.makeUnsafe(1),
          publishing: Semaphore.makeUnsafe(1),
          flow: Latch.makeUnsafe(true),
          confirmCapacity: Latch.makeUnsafe(true),
          admissionClosed: Deferred.makeUnsafe(),
          confirms: new Map(),
          consumers: new Map(),
          active: true,
          closing: false,
          pending: undefined,
          content: undefined,
          sequence: BigInt(0)
        }
        epoch.channels.set(physical.id, physical)
        logical.physical = physical
        yield* rpc(epoch, physical, Protocol.ChannelOpen, { reserved1: "" })
        if (logical.options.confirm === true) {
          yield* rpc(epoch, physical, Protocol.ConfirmSelect, { noWait: false })
        }
        yield* rpc(epoch, physical, Protocol.BasicQos, {
          prefetchSize: 0,
          prefetchCount: logical.prefetch,
          global: false
        })
        if (logical.globalPrefetch !== undefined) {
          yield* rpc(epoch, physical, Protocol.BasicQos, {
            prefetchSize: 0,
            prefetchCount: logical.globalPrefetch,
            global: true
          })
        }
        return physical
      }
    )

    const declareExchange = (physical: Physical, declaration: DesiredTopology.ExchangeDeclaration) =>
      rpc(
        physical.epoch,
        physical,
        Protocol.ExchangeDeclare,
        {
          reserved1: 0,
          exchange: declaration.exchange,
          type: declaration.type,
          passive: false,
          durable: declaration.options.durable ?? true,
          autoDelete: declaration.options.autoDelete ?? false,
          internal: declaration.options.internal ?? false,
          noWait: false,
          arguments: declaration.options.arguments ?? {}
        }
      )

    const declareQueue = (physical: Physical, queue: string, opts: AMQPTypes.QueueOptions, passive = false) =>
      rpc(
        physical.epoch,
        physical,
        Protocol.QueueDeclare,
        {
          reserved1: 0,
          queue,
          passive,
          durable: opts.durable ?? true,
          exclusive: opts.exclusive ?? false,
          autoDelete: opts.autoDelete ?? false,
          noWait: false,
          arguments: opts.arguments ?? {}
        }
      ).pipe(Effect.flatMap((reply) => Protocol.queueReply(reply.method)))

    const applyBinding = (physical: Physical, binding: DesiredTopology.Binding, remove = false) =>
      rpc(
        physical.epoch,
        physical,
        binding.queue === undefined
          ? (remove ? Protocol.ExchangeUnbind : Protocol.ExchangeBind)
          : (remove ? Protocol.QueueUnbind : Protocol.QueueBind),
        {
          reserved1: 0,
          ...(binding.queue === undefined
            ? { destination: binding.destination ?? "", source: binding.source, noWait: false }
            : {
              queue: DesiredTopology.queueName(binding.queue),
              exchange: binding.source,
              ...(remove ? {} : { noWait: false })
            }),
          routingKey: binding.routingKey,
          arguments: binding.arguments
        }
      ).pipe(Effect.asVoid)

    const startConsumer = Effect.fnUntraced(
      function*(physical: Physical, consumer: Consumer): Effect.fn.Return<void, Error> {
        if (!consumer.active) return
        const count = consumer.options.prefetch ?? physical.logical.prefetch
        yield* rpc(physical.epoch, physical, Protocol.BasicQos, {
          prefetchSize: 0,
          prefetchCount: count,
          global: false
        })
        if (!consumer.active) return
        consumer.tag = ""
        const reply = yield* rpc(physical.epoch, physical, Protocol.BasicConsume, {
          reserved1: 0,
          queue: DesiredTopology.queueName(consumer.queue),
          consumerTag: consumer.options.consumerTag ?? "",
          noLocal: false,
          noAck: false,
          exclusive: consumer.options.exclusive ?? false,
          noWait: false,
          arguments: consumer.options.arguments ?? {}
        })
        consumer.tag = yield* Protocol.readString(reply.method, "consumerTag")
        physical.consumers.set(consumer.tag, consumer)
      }
    )

    const topologyRestorer = (logical: Logical): DesiredTopology.Restorer<Consumer, Error> | undefined => {
      const physical = logical.physical
      if (physical === undefined || logical.closed || logical.error !== undefined) return
      return {
        exchange: (declaration) => declareExchange(physical, declaration).pipe(Effect.asVoid),
        queue: (requested, options) => declareQueue(physical, requested, options),
        binding: (binding) => applyBinding(physical, binding),
        consumer: (consumer) => startConsumer(physical, consumer),
        ready: () => {
          if (physical.active && physical.epoch.active && physical.epoch.brokerCloseError === undefined) {
            logical.ready.openUnsafe()
          }
        }
      }
    }

    const restoreOne = Effect.fnUntraced(function*(epoch: Epoch, logical: Logical): Effect.fn.Return<void> {
      const result = yield* Effect.exit(Effect.gen(function*() {
        yield* openPhysical(epoch, logical)
        yield* topology.restore([logical], topologyRestorer, (_logical, error) => Effect.fail(error))
      }))
      if (Exit.isFailure(result) && epoch.active && epoch.brokerCloseError === undefined && !logical.closed) {
        const error = Cause.findErrorOption(result.cause)
        failLogical(
          logical,
          Option.isSome(error) ? error.value : channelError("Channel topology recovery failed", result.cause)
        )
      }
    })

    const handleMethod = Effect.fnUntraced(
      function*(
        epoch: Epoch,
        channel: number,
        method: Codec.Method,
        methodBytes: number
      ): Effect.fn.Return<void, Error> {
        const key = yield* Protocol.lookup(method.classId, method.methodId)
        if (channel === 0) {
          if (key === Protocol.ConnectionClose) {
            const replyCode = yield* Protocol.readNumber(method, "replyCode")
            const error = new AMQPError.AMQPConnectionError({
              reason: yield* Protocol.readString(method, "replyText"),
              replyCode,
              classId: yield* Protocol.readNumber(method, "classId"),
              methodId: yield* Protocol.readNumber(method, "methodId"),
              permanent: [402, 403, 404, 405, 406, 501, 502, 503, 504, 505, 530, 540].includes(replyCode)
            })
            // Retire application capabilities promptly. The writer gets a bounded chance to send close-ok while
            // this reader remains able to observe transport failure, including a disconnected writer that suspends.
            epoch.brokerCloseError = error
            brokerClosing = epoch
            epoch.blocked = "Broker closing connection"
            epoch.publishGate.closeUnsafe()
            ready.closeUnsafe()
            if (current === epoch) current = undefined
            if (epoch.pending !== undefined) finish(epoch.pending.done, Effect.fail(error))
            for (const physical of epoch.channels.values()) retirePhysical(physical, error)
            yield* sendMethod(epoch, 0, Protocol.ConnectionCloseOk, {}, true).pipe(
              Effect.timeout("1 second"),
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => failEpoch(epoch, error))),
              Effect.forkIn(epoch.scope)
            )
          } else if (key === Protocol.ConnectionBlocked) {
            const reason = yield* Protocol.readString(method, "reason")
            epoch.blocked = reason
            epoch.publishGate.closeUnsafe()
            yield* SubscriptionRef.update(
              state,
              (value) => ({ ...value, blocked: reason })
            )
          } else if (key === Protocol.ConnectionUnblocked) {
            epoch.blocked = undefined
            epoch.publishGate.openUnsafe()
            epoch.wakeWriter.openUnsafe()
            yield* SubscriptionRef.update(state, (value) => {
              const { blocked: _blocked, ...rest } = value
              return rest
            })
          } else {
            if (key === Protocol.ConnectionTune) {
              const serverFrame = yield* Protocol.readNumber(method, "frameMax")
              if (serverFrame !== 0 && serverFrame < 4096) {
                return yield* new AMQPError.AMQPProtocolError({ reason: "Broker advertised invalid frameMax" })
              }
              // Negotiation cannot wait for StartOk's write to finish: tune and another frame can already
              // be readable while that write remains backpressured.
              const frameMax = serverFrame === 0 ? requestedFrameMax : requestedFrameMax === 0 ?
                serverFrame :
                Math.min(serverFrame, requestedFrameMax)
              epoch.frameMax = frameMax === 0 ? maxBufferedBytes : frameMax
            }
            yield* completeReply(epoch.pending, method)
          }
          return
        }
        const physical = epoch.channels.get(channel)
        if (physical === undefined) {
          return yield* new AMQPError.AMQPProtocolError({ reason: "Frame on unopened channel" })
        }
        if (!physical.active) {
          // Unsafe retirements retain their number until a close barrier has drained every old slot and write.
          if (key === Protocol.ChannelClose) yield* sendControl(epoch, channel, Protocol.ChannelCloseOk)
          return
        }
        if (physical.content !== undefined && key !== Protocol.ChannelClose) {
          return yield* new AMQPError.AMQPProtocolError({ reason: "Method interleaved with content frames" })
        }
        if (key === Protocol.ChannelClose) {
          const error = new AMQPError.AMQPChannelError({
            reason: yield* Protocol.readString(method, "replyText"),
            replyCode: yield* Protocol.readNumber(method, "replyCode"),
            classId: yield* Protocol.readNumber(method, "classId"),
            methodId: yield* Protocol.readNumber(method, "methodId")
          })
          // Admission is invalidated synchronously before recovery starts.
          const recover = physical.logical.ready.isOpen()
          const recoverSession = recover && !physical.logical.closed && physical.logical.error === undefined &&
            !closing && topology.hasEphemeralQueues(physical.logical, (consumer) => consumer.queue)
          if (recoverSession) {
            // Completing the failed RPC can synchronously resume its caller. Fence readiness and publication
            // first, before that caller can observe this soon-to-be-retired session as ready.
            ready.closeUnsafe()
            epoch.publishGate.closeUnsafe()
          }
          retirePhysical(physical, error)
          // Non-confirming publishes may already have completed their write. Keep the broker's
          // channel error observable even when no RPC or confirmation caller remains to receive it.
          yield* SubscriptionRef.update(state, (value) => ({ ...value, error }))
          if (recoverSession) {
            // Retiring the transport replaces the entire session; a channel-only close barrier is unnecessary.
            failEpoch(epoch, connectionError("Ephemeral queue owner channel retired", error))
            return
          }
          const acknowledged = yield* sendControl(epoch, channel, Protocol.ChannelCloseOk)
          yield* Effect.gen(function*() {
            yield* Deferred.await(acknowledged.done).pipe(
              Effect.andThen(reclaimPhysical(physical)),
              Effect.timeout(shutdownTimeout),
              Effect.catch((cause) =>
                Effect.sync(() => failEpoch(epoch, connectionError("Channel close barrier failed", cause)))
              )
            )
            if (
              recover && epoch.active && !physical.logical.closed && physical.logical.error === undefined && !closing
            ) {
              yield* restoreOne(epoch, physical.logical)
            }
          }).pipe(Effect.forkIn(epoch.scope))
        } else if (key === Protocol.ChannelFlow) {
          if (method.fields.active === true) {
            physical.flow.openUnsafe()
            epoch.wakeWriter.openUnsafe()
          } else physical.flow.closeUnsafe()
          if (!physical.closing) {
            yield* sendControl(epoch, channel, Protocol.ChannelFlowOk, { active: method.fields.active === true })
          }
        } else if (key === Protocol.BasicAck || key === Protocol.BasicNack) {
          const tag = yield* Protocol.readBigInt(method, "deliveryTag")
          if (tag > physical.sequence) {
            return yield* new AMQPError.AMQPProtocolError({ reason: "Invalid publisher confirm tag" })
          }
          const multiple = method.fields.multiple === true
          const confirmed: Array<Deferred.Deferred<void, Error>> = []
          for (const [sequence, confirm] of physical.confirms) {
            if (sequence === tag || (multiple && (tag === BigInt(0) || sequence <= tag))) {
              physical.confirms.delete(sequence)
              confirmed.push(confirm)
            }
          }
          // Completing a deferred may synchronously admit the caller's next publish. Freeze this broker
          // reply's affected slots before resuming any caller, especially for the zero-tag "all" case.
          for (const confirm of confirmed) {
            finish(
              confirm,
              key === Protocol.BasicAck ? Effect.void : Effect.fail(publishError("Nacked", "Broker nacked publish"))
            )
          }
          if (physical.confirms.size < (physical.logical.options.maxUnconfirmed ?? 1024)) {
            physical.confirmCapacity.openUnsafe()
          }
        } else if (key === Protocol.BasicCancel) {
          const tag = yield* Protocol.readString(method, "consumerTag")
          const consumer = physical.consumers.get(tag)
          physical.consumers.delete(tag)
          if (consumer !== undefined) {
            consumer.active = false
            yield* requeueBufferedConsumer(consumer)
            topology.removeConsumer(physical.logical, consumer)
            yield* Queue.fail(consumer.mailbox, channelError(`Broker cancelled consumer ${tag}`))
          }
          if (method.fields.noWait !== true && !physical.closing) {
            yield* sendControl(epoch, channel, Protocol.BasicCancelOk, { consumerTag: tag })
          }
        } else if (key === Protocol.BasicDeliver || key === Protocol.BasicReturn || key === Protocol.BasicGetOk) {
          if (physical.content !== undefined) {
            return yield* new AMQPError.AMQPProtocolError({
              reason: "Interleaved content methods"
            })
          }
          if (key === Protocol.BasicGetOk && !physical.pending?.expected.includes(key)) {
            return yield* new AMQPError.AMQPProtocolError({ reason: "Unsolicited basic.get-ok" })
          }
          yield* reserve(physical, methodBytes + 128, (release) => {
            physical.content = {
              method,
              properties: undefined,
              body: undefined,
              offset: 0,
              release
            }
          })
        } else {
          // Consume tags must become visible before a following delivery in the same read batch.
          if (key === Protocol.BasicConsumeOk) {
            const tag = yield* Protocol.readString(method, "consumerTag")
            const consumer = Array.from(topology.consumers(physical.logical)).find((item) =>
              item.active && item.tag === ""
            )
            if (consumer !== undefined) {
              consumer.tag = tag
              physical.consumers.set(tag, consumer)
            }
          }
          yield* completeReply(physical.pending, method)
        }
      }
    )

    const dispatch = Effect.fnUntraced(function*(epoch: Epoch, frame: Codec.Frame): Effect.fn.Return<void, Error> {
      if (!epoch.active) return
      if (frame.payload.byteLength + 8 > epoch.frameMax) {
        return yield* new AMQPError.AMQPProtocolError({ reason: "Frame exceeds negotiated frameMax" })
      }
      if (frame.type === 8) {
        if (frame.channel !== 0 || frame.payload.byteLength !== 0) {
          return yield* new AMQPError.AMQPProtocolError({ reason: "Invalid heartbeat frame" })
        }
        return
      }
      if (frame.type === 1) {
        const method = yield* Codec.decodeMethod(frame.payload)
        return yield* handleMethod(epoch, frame.channel, method, frame.payload.byteLength + 8)
      }
      const physical = epoch.channels.get(frame.channel)
      if (physical === undefined || !physical.active) {
        return yield* new AMQPError.AMQPProtocolError({ reason: "Content frame on unavailable channel" })
      }
      const content = physical.content
      if (content === undefined) return yield* new AMQPError.AMQPProtocolError({ reason: "Content without method" })
      if (frame.type === 2) {
        if (content.body !== undefined) {
          return yield* new AMQPError.AMQPProtocolError({ reason: "Duplicate content header" })
        }
        // Charge raw header bytes and envelope/property overhead before decoding a potentially expanding table.
        yield* reserve(physical, frame.payload.byteLength + 8 + 128, (release) => {
          content.release = combineReleases(content.release, release)
        })
        const header = yield* Codec.decodeContentHeader(frame.payload, {
          maxDecodedBytes: Math.min(Codec.MAX_DECODED_BYTES, maxBufferedBytes - epoch.bufferedBytes)
        })
        yield* reserve(physical, header.decodedCost, (release) => {
          content.release = combineReleases(content.release, release)
        })
        if (header.bodySize > BigInt(maxMessageBytes)) {
          return yield* new AMQPError.AMQPProtocolError({ reason: "Message exceeds maxMessageBytes" })
        }
        const bytes = Number(header.bodySize)
        yield* reserve(physical, bytes, (release) => {
          content.release = combineReleases(content.release, release)
        })
        content.properties = header.properties
        content.body = yield* wire(() => new Uint8Array(bytes))
        if (bytes === 0) yield* deliverContent(physical)
      } else if (frame.type === 3) {
        if (
          content.body === undefined || frame.payload.byteLength === 0 ||
          content.offset + frame.payload.byteLength > content.body.byteLength
        ) {
          return yield* new AMQPError.AMQPProtocolError({ reason: "Invalid content body size or sequence" })
        }
        content.body.set(frame.payload, content.offset)
        content.offset += frame.payload.byteLength
        if (content.offset === content.body.byteLength) yield* deliverContent(physical)
      } else {
        return yield* new AMQPError.AMQPProtocolError({ reason: `Unsupported frame type ${frame.type}` })
      }
    })

    const handshake = Effect.fnUntraced(function*(epoch: Epoch): Effect.fn.Return<void, Error> {
      const start: Pending = { expected: [Protocol.ConnectionStart], done: Deferred.makeUnsafe() }
      epoch.pending = start
      yield* enqueue(epoch, [Codec.PROTOCOL_HEADER])
      const { method } = yield* Deferred.await(start.done)
      epoch.pending = undefined
      const serverProperties = yield* Protocol.readTable(method, "serverProperties")
      const mechanisms = yield* Protocol.readString(method, "mechanisms")
      const locales = yield* Protocol.readString(method, "locales")
      if (
        method.fields.versionMajor !== 0 || method.fields.versionMinor !== 9 || !mechanisms.split(" ").includes("PLAIN")
      ) {
        return yield* connectionError("Broker does not support AMQP 0-9-1 PLAIN authentication", undefined, true)
      }
      if (!locales.split(" ").includes("en_US")) {
        return yield* connectionError("Broker does not support en_US locale", undefined, true)
      }
      epoch.serverProperties = serverProperties
      const password = Redacted.isRedacted(secret) ? Redacted.value(secret) : secret
      const username = options.username ?? "guest"
      if (username.includes("\0") || password.includes("\0")) {
        return yield* connectionError("PLAIN credentials must not contain NUL", undefined, true)
      }
      const tune = yield* rpc(epoch, undefined, Protocol.ConnectionStartOk, {
        clientProperties: {
          product: "effect-messaging",
          version: "0.8.0",
          platform: "Effect",
          capabilities: {
            publisher_confirms: true,
            "exchange_exchange_bindings": true,
            "basic.nack": true,
            "consumer_cancel_notify": true,
            "connection.blocked": true,
            "authentication_failure_close": true
          },
          ...options.clientProperties,
          ...(options.connectionName === undefined ? {} : { connection_name: options.connectionName })
        },
        mechanism: "PLAIN",
        response: new TextEncoder().encode(`\0${username}\0${password}`),
        locale: "en_US"
      })
      const serverFrame = yield* Protocol.readNumber(tune.method, "frameMax")
      const serverChannel = yield* Protocol.readNumber(tune.method, "channelMax")
      const serverHeartbeat = yield* Protocol.readNumber(tune.method, "heartbeat")
      if (serverFrame !== 0 && serverFrame < 4096) {
        return yield* connectionError("Broker advertised invalid frameMax", undefined, true)
      }
      const negotiate = (server: number, client: number) =>
        server === 0 ? client : client === 0 ? server : Math.min(server, client)
      const frameMax = negotiate(serverFrame, requestedFrameMax)
      // Zero means no protocol limit, not an unbounded local allocation.
      epoch.frameMax = frameMax === 0 ? maxBufferedBytes : frameMax
      epoch.channelMax = negotiate(serverChannel, requestedChannelMax) || 65535
      epoch.heartbeat = serverHeartbeat === 0 || requestedHeartbeat === 0
        ? Math.max(serverHeartbeat, requestedHeartbeat)
        : Math.min(serverHeartbeat, requestedHeartbeat)
      yield* sendMethod(epoch, 0, Protocol.ConnectionTuneOk, {
        channelMax: negotiate(serverChannel, requestedChannelMax),
        frameMax,
        heartbeat: epoch.heartbeat
      })
      yield* rpc(epoch, undefined, Protocol.ConnectionOpen, {
        virtualHost: options.virtualHost ?? "/",
        reserved1: "",
        outOfBand: false
      })
    })

    const heartbeatPass = Effect.fnUntraced(function*(epoch: Epoch): Effect.fn.Return<void> {
      if (!epoch.active) return
      const now = yield* Clock.currentTimeMillis
      if (now - epoch.lastRead >= epoch.heartbeat * 1000) {
        failEpoch(epoch, epoch.brokerCloseError ?? connectionError("Heartbeat receive timeout"))
        return
      }
      if (now - epoch.lastWrite >= epoch.heartbeat * 500) {
        yield* Effect.gen(function*() {
          // Receive liveness never waits for the writer. Coalesce heartbeat sends to one bounded command
          // while transport backpressure stalls the writer, so each scheduled pass can still check lastRead.
          if (epoch.heartbeatWrite !== undefined && !Deferred.isDoneUnsafe(epoch.heartbeatWrite.done)) return
          const frame = yield* Codec.encodeFrame(8, 0, new Uint8Array())
          yield* Effect.suspend(() => {
            if (epoch.heartbeatWrite !== undefined && !Deferred.isDoneUnsafe(epoch.heartbeatWrite.done)) {
              return Effect.void
            }
            return Effect.fromResult(submit(epoch, [frame], false, undefined, true)).pipe(
              Effect.map((command) => {
                epoch.heartbeatWrite = command
              })
            )
          })
        }).pipe(
          Effect.catch((error) => Effect.sync(() => failEpoch(epoch, connectionError("Heartbeat write failed", error))))
        )
      }
    })

    const session = Effect.gen(function*() {
      if (closing) return
      generation++
      yield* setState({ state: generation === 1 ? "Connecting" : "Reconnecting", generation })
      let sessionEpoch: Epoch | undefined
      return yield* Effect.scoped(
        Effect.gen(function*() {
          const epochScope = yield* Effect.scope
          const socket = yield* socketFactory.pipe(
            Effect.mapError((cause) => connectionError("Transport construction failed", cause))
          )
          // Exactly one acquisition on a fresh Socket owns the entire physical session.
          const pull = yield* Socket.readerBytes(socket).pipe(
            Effect.timeout(connectionTimeout),
            Effect.mapError((cause) => connectionError("Transport connection failed", cause))
          )
          const writer = yield* socket.writer
          const now = yield* Clock.currentTimeMillis
          const epoch: Epoch = {
            generation,
            scope: epochScope,
            writer,
            failure: Deferred.makeUnsafe(),
            wakeWriter: Latch.makeUnsafe(),
            publishGate: Latch.makeUnsafe(true),
            control: [],
            data: [],
            channels: new Map(),
            freeChannels: [],
            rpc: Semaphore.makeUnsafe(1),
            active: true,
            nextChannel: 1,
            pending: undefined,
            writing: undefined,
            outboundBytes: 0,
            outboundCommands: 0,
            bufferedBytes: 0,
            frameMax: Math.max(requestedFrameMax || maxBufferedBytes, 4096),
            channelMax: 65535,
            heartbeat: 0,
            heartbeatWrite: undefined,
            lastRead: now,
            lastWrite: now,
            serverProperties: {},
            brokerCloseError: undefined,
            blocked: undefined
          }
          current = epoch
          sessionEpoch = epoch
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => failEpoch(epoch, connectionError("Physical session retired")))
          )
          yield* writerLoop(epoch).pipe(
            Effect.ensuring(Effect.sync(() => {
              const writing = epoch.writing
              epoch.writing = undefined
              if (writing !== undefined) finish(writing.drained, Effect.void)
            })),
            Effect.forkScoped
          )
          const decoder = yield* Codec.makeFrameDecoder(epoch.frameMax, maxBufferedBytes)
          const readerLoop = Effect.gen(function*() {
            while (epoch.active) {
              const batch = yield* pull
              epoch.lastRead = yield* Clock.currentTimeMillis
              for (const chunk of batch) {
                if (!epoch.active) break
                yield* decoder.setMaxFrameSize(epoch.frameMax)
                yield* decoder.feed(chunk, (frame) =>
                  dispatch(epoch, frame).pipe(
                    Effect.andThen(Effect.suspend(() => decoder.setMaxFrameSize(epoch.frameMax))),
                    Effect.map(() => epoch.active)
                  ))
              }
            }
          }).pipe(Effect.catchCause((cause) =>
            Effect.sync(() => {
              const error = Cause.findErrorOption(cause)
              failEpoch(
                epoch,
                epoch.brokerCloseError ??
                  connectionError(
                    "AMQP reader failed",
                    cause,
                    Option.isSome(error) && error.value instanceof AMQPError.AMQPProtocolError
                  )
              )
            })
          ))
          yield* readerLoop.pipe(Effect.forkScoped)
          yield* setState({ state: "Handshaking", generation })
          yield* handshake(epoch).pipe(
            Effect.timeout(connectionTimeout),
            Effect.mapError((error) =>
              error instanceof AMQPError.AMQPConnectionError
                ? error
                : connectionError("AMQP handshake failed", error, error instanceof AMQPError.AMQPProtocolError)
            )
          )
          if (epoch.heartbeat > 0) {
            yield* heartbeatPass(epoch).pipe(
              Effect.repeat(Schedule.spaced(epoch.heartbeat * 500)),
              Effect.forkScoped
            )
          }
          yield* setState({
            state: "Recovering",
            generation,
            ...(epoch.blocked === undefined ? {} : { blocked: epoch.blocked })
          })
          const recoverable = Array.from(logicals).filter((logical) => !logical.closed && logical.error === undefined)
          for (const logical of recoverable) {
            yield* openPhysical(epoch, logical).pipe(Effect.catch((error) => {
              if (epoch.brokerCloseError !== undefined) return Effect.fail(epoch.brokerCloseError)
              if (!epoch.active) return Effect.fail(connectionError("Session lost while opening channels", error))
              failLogical(logical, error)
              return Effect.void
            }))
          }
          yield* topology.restore(recoverable, topologyRestorer, (logical, error) => {
            if (epoch.brokerCloseError !== undefined) return Effect.fail(epoch.brokerCloseError)
            if (!epoch.active) return Effect.fail(connectionError("Session lost during topology recovery", error))
            failLogical(logical, error)
            return Effect.void
          })
          if (!epoch.active || epoch.brokerCloseError !== undefined) return yield* Deferred.await(epoch.failure)
          yield* setState({
            state: "Ready",
            generation,
            ...(epoch.blocked === undefined ? {} : { blocked: epoch.blocked })
          })
          ready.openUnsafe()
          return yield* Deferred.await(epoch.failure)
        }).pipe(Effect.ensuring(Effect.gen(function*() {
          const epoch = sessionEpoch
          if (epoch === undefined) return
          // Handshake/recovery failures may resume before the close-ok writer starts. Give that
          // writer its bounded chance before closing the scope that owns both transport fibers.
          yield* awaitBrokerClose(epoch).pipe(Effect.timeout("1 second"), Effect.ignore)
          failEpoch(epoch, connectionError("Physical session retired"))
        })))
      )
    }).pipe(Effect.mapError((error) =>
      error instanceof AMQPError.AMQPConnectionError
        ? error
        : connectionError("Physical connection failed", error)
    ))

    const supervisor = session.pipe(
      Effect.tapError((error) => setState({ state: "Reconnecting", generation, error })),
      Effect.retry({
        schedule: options.retryConnectionSchedule ?? Schedule.exponential("250 millis").pipe(
          Schedule.jittered,
          Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(30))))
        ),
        while: (error) => !closing && error.permanent !== true
      }),
      Effect.catch((error) =>
        Effect.gen(function*() {
          if (closing) return
          yield* stop(error)
          yield* setState({ state: "Failed", generation, error })
          yield* Effect.logError("AMQP connection supervisor stopped", error)
        })
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          if (closing) return
          const error = connectionError("Connection supervisor stopped", cause, true)
          yield* stop(error)
          yield* setState({ state: "Failed", generation, error })
          yield* Effect.logError("AMQP connection supervisor stopped", cause)
        })
      )
    )
    const supervisorFiber = yield* supervisor.pipe(Effect.forkIn(scope))

    const operation = <A>(
      logical: Logical,
      run: (physical: Physical) => Effect.Effect<A, Error>
    ): Effect.Effect<A, Error> =>
      Effect.suspend(() => {
        if (logical.pendingOperations >= maxPending) {
          return Effect.fail(channelError("Pending operation limit exceeded"))
        }
        logical.pendingOperations++
        return logical.operations.withPermit(awaitPhysical(logical).pipe(Effect.flatMap(run))).pipe(
          Effect.ensuring(Effect.sync(() => {
            logical.pendingOperations--
          }))
        )
      })

    const cancelConsumer = Effect.fnUntraced(
      function*(logical: Logical, consumer: Consumer): Effect.fn.Return<void, Error> {
        if (!consumer.active) return
        // Unregister desired consumption before any network wait, so shutdown cannot resurrect it.
        consumer.active = false
        topology.removeConsumer(logical, consumer)
        const physical = logical.physical
        let admitted = false
        yield* Effect.gen(function*() {
          if (physical !== undefined && physical.active && physical.epoch.active) {
            if (physical.closing) return
            if (consumer.tag === "") {
              failEpoch(physical.epoch, connectionError("Consumer cancelled during registration"))
              return
            }
            yield* rpc(
              physical.epoch,
              physical,
              Protocol.BasicCancel,
              { consumerTag: consumer.tag, noWait: false },
              connectionTimeout,
              () => {
                admitted = true
              }
            )
            physical.consumers.delete(consumer.tag)
          }
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // Without a channel-close barrier, even an unadmitted cancel must retire the broker's live consumer.
              if (
                Exit.isFailure(exit) && physical !== undefined && physical.active && physical.epoch.active &&
                (admitted || (!logical.closed && !physical.closing && !closing))
              ) {
                failEpoch(physical.epoch, connectionError("Consumer cancellation failed", exit.cause))
              }
            })
          ),
          Effect.ensuring(
            requeueBufferedConsumer(consumer).pipe(
              Effect.andThen(Effect.sync(() => Queue.endUnsafe(consumer.mailbox)))
            )
          )
        )
      }
    )

    const drainConfirms = (physical: Physical) =>
      Effect.forEach(
        Array.from(physical.confirms.values()),
        (confirm) => Deferred.await(confirm).pipe(Effect.ignore),
        { discard: true }
      )

    const closeLogical = Effect.fnUntraced(function*(logical: Logical): Effect.fn.Return<void> {
      if (logical.closed) return yield* Deferred.await(logical.closeDone)
      logical.closed = true
      logicals.delete(logical)
      const physical = logical.physical
      if (physical !== undefined) finish(physical.admissionClosed, Effect.void)
      const shutdown = Effect.gen(function*() {
        for (const consumer of Array.from(topology.consumers(logical))) {
          yield* cancelConsumer(logical, consumer).pipe(Effect.ignore)
        }
        if (physical !== undefined && physical.active && physical.epoch.active) {
          yield* drainConfirms(physical).pipe(Effect.ignore)
          yield* rpc(
            physical.epoch,
            physical,
            Protocol.ChannelClose,
            {
              replyCode: 200,
              replyText: "Goodbye",
              classId: 0,
              methodId: 0
            },
            shutdownTimeout
          )
          yield* reclaimPhysical(physical)
        }
      })
      yield* shutdown.pipe(
        Effect.interruptible,
        Effect.timeout(shutdownTimeout),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => {
          if (physical !== undefined) retirePhysical(physical, channelError("Channel closed"))
          if (
            physical !== undefined && physical.epoch.active && physical.epoch.brokerCloseError === undefined &&
            physical.epoch.channels.get(physical.id) === physical
          ) {
            // Never reuse a number after an uncertain close, including interruption while draining confirms.
            failEpoch(physical.epoch, connectionError("Channel shutdown did not reach a safe close barrier"))
          }
          logical.ready.openUnsafe()
          for (const consumer of topology.consumers(logical)) {
            consumer.active = false
            discard(consumer.mailbox)
            Queue.endUnsafe(consumer.mailbox)
          }
          topology.remove(logical)
          discard(logical.returned)
          Queue.endUnsafe(logical.returned)
          finish(logical.closeDone, Effect.void)
        }))
      )
    })

    const createChannel = Effect.fn("AMQPConnection.createChannel")(function*(
      channelOptions: AMQPChannel.AMQPChannelOptions = {}
    ): Effect.fn.Return<AMQPChannel.AMQPChannel, Error, Scope.Scope> {
      channelOptions = { ...channelOptions }
      yield* integer("prefetch", channelOptions.prefetch ?? 50, 1, 65535)
      yield* integer("maxUnconfirmed", channelOptions.maxUnconfirmed ?? 1024, 1, 65535)
      const logical: Logical = {
        options: channelOptions,
        ready: Latch.makeUnsafe(),
        closeDone: Deferred.makeUnsafe(),
        operations: Semaphore.makeUnsafe(1),
        returned: yield* Queue.make<Envelope<AMQPTypes.ReturnedMessage>, Error | Cause.Done>({
          capacity: 64,
          strategy: "dropping"
        }),
        physical: undefined,
        closed: false,
        error: undefined,
        prefetch: channelOptions.prefetch ?? 50,
        globalPrefetch: undefined,
        pendingOperations: 0
      }
      const epoch = yield* awaitEpoch
      logicals.add(logical)
      yield* Effect.addFinalizer(() => closeLogical(logical))
      const physical = yield* openPhysical(epoch, logical).pipe(
        Effect.catch((error) => !epoch.active && !closing ? awaitPhysical(logical) : Effect.fail(error)),
        Effect.tapError(() => closeLogical(logical)),
        Effect.onInterrupt(() => closeLogical(logical))
      )
      if (physical.active) logical.ready.openUnsafe()

      const publishImpl = Effect.fn("AMQPChannel.publish")(function*(
        exchange: string,
        routingKey: string | (() => string),
        content: Uint8Array,
        publishOptions: AMQPTypes.PublishOptions = {}
      ): Effect.fn.Return<void, Error> {
        if (!isContent(content)) {
          return yield* publishError("NotSent", "Message content must be a Uint8Array")
        }
        if (content.byteLength > maxMessageBytes) {
          return yield* publishError("NotSent", "Message exceeds maxMessageBytes")
        }
        const target = yield* awaitPhysical(logical).pipe(
          Effect.mapError((error) => publishError("NotSent", "Channel unavailable", error))
        )
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            let admitted: PublishAdmission | undefined
            while (admitted === undefined) {
              // Capacity and broker-flow waits own no publish or RPC lock. Closing this physical channel wakes
              // every waiter; none may migrate an unadmitted publish onto a replacement session.
              yield* restore(Effect.raceFirst(
                target.epoch.publishGate.await.pipe(
                  Effect.andThen(target.flow.await),
                  Effect.andThen(target.confirmCapacity.await)
                ),
                Deferred.await(target.admissionClosed).pipe(
                  Effect.andThen(Effect.fail(publishError("NotSent", "Session retired before publish admission")))
                )
              ))
              admitted = yield* target.publishing.withPermit(
                Effect.gen(function*() {
                  const properties: AMQPTypes.MessageProperties = {
                    ...publishOptions,
                    ...(publishOptions.persistent === undefined
                      ? {}
                      : { deliveryMode: publishOptions.persistent ? 2 : 1 })
                  }
                  const key = typeof routingKey === "string" ? routingKey : yield* Effect.try({
                    try: routingKey,
                    catch: (cause) => publishError("NotSent", "Routing key resolution failed", cause)
                  })
                  const frames = [
                    yield* Codec.encodeMethod(target.id, Protocol.BasicPublish, {
                      reserved1: 0,
                      exchange,
                      routingKey: key,
                      mandatory: publishOptions.mandatory ?? false,
                      immediate: false
                    }),
                    yield* Codec.encodeContentHeader(target.id, BigInt(content.byteLength), properties)
                  ]
                  const bodyMax = target.epoch.frameMax - 8
                  for (let offset = 0; offset < content.byteLength; offset += bodyMax) {
                    frames.push(yield* Codec.encodeFrame(3, target.id, content.subarray(offset, offset + bodyMax)))
                  }
                  // Effects above may yield. All final checks, reservation and state installation below
                  // share one synchronous turn, with no effect execution between validation and commit.
                  return yield* Effect.suspend((): Effect.Effect<PublishAdmission | undefined, Error> => {
                    if (!target.active || !target.epoch.active || target.closing || logical.closed || closing) {
                      return Effect.fail(publishError("NotSent", "Session retired before publish admission"))
                    }
                    // A competing publisher or a broker control may have changed admission after the wakeup.
                    // Recheck synchronously and retry outside the lock instead of consuming a stale permit.
                    if (!target.epoch.publishGate.isOpen() || !target.flow.isOpen()) return Effect.succeed(undefined)
                    if (target.confirms.size >= (channelOptions.maxUnconfirmed ?? 1024)) {
                      target.confirmCapacity.closeUnsafe()
                      return Effect.succeed(undefined)
                    }
                    if (target.epoch.outboundBytes + content.byteLength > maxOutboundBytes) {
                      return Effect.fail(publishError("NotSent", "Outbound byte admission limit exceeded"))
                    }
                    // Commit the command and sequence slot atomically, including installation of interruption
                    // cleanup below. A timed-out slot continues to consume capacity until ack/nack or retirement.
                    const confirm = channelOptions.confirm === true ? Deferred.makeUnsafe<void, Error>() : undefined
                    const result = submit(target.epoch, frames, true, target, false, () => {
                      if (confirm !== undefined) {
                        target.sequence++
                        target.confirms.set(target.sequence, confirm)
                        if (target.confirms.size >= (channelOptions.maxUnconfirmed ?? 1024)) {
                          target.confirmCapacity.closeUnsafe()
                        }
                      }
                    })
                    return Effect.fromResult(Result.map(result, (command) => ({ command, confirm })))
                  })
                }).pipe(Effect.mapError((cause) =>
                  cause instanceof AMQPError.AMQPPublishError
                    ? cause
                    : publishError("NotSent", "Publish admission failed", cause)
                ))
              )
            }
            const confirmation = admitted.confirm
            // Once admitted, the writer completes this publish even if its caller is interrupted. Neither
            // transport completion nor confirmation waiting holds the local publish admission lock.
            yield* restore(Deferred.await(admitted.command.done)).pipe(Effect.onInterrupt(() =>
              Effect.sync(() => {
                if (confirmation !== undefined) {
                  finish(confirmation, Effect.fail(publishError("Unknown", "Publisher interrupted after admission")))
                }
              })
            ))
            if (confirmation === undefined) return
            return yield* restore(
              Deferred.await(confirmation).pipe(
                Effect.timeout(channelOptions.confirmTimeout ?? "30 seconds"),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    finish(
                      confirmation,
                      Effect.fail(publishError("Unknown", "Publisher interrupted before confirmation"))
                    )
                  })
                ),
                Effect.catchTag("TimeoutError", () => {
                  const error = publishError("Unknown", "Timed out waiting for publisher confirmation")
                  // Keep the sequence slot until the broker replies, but do not leave shutdown draining an abandoned waiter.
                  finish(confirmation, Effect.fail(error))
                  return Effect.fail(error)
                })
              )
            )
          })
        )
      })

      const publish = (
        exchange: string,
        routingKey: string | (() => string),
        content: Uint8Array,
        opts?: AMQPTypes.PublishOptions
      ): Effect.Effect<void, Error> =>
        Effect.suspend(() => {
          if (logical.pendingOperations >= maxPending) {
            return Effect.fail(publishError("NotSent", "Pending publish admission limit exceeded"))
          }
          logical.pendingOperations++
          return publishImpl(exchange, routingKey, content, opts).pipe(
            Effect.ensuring(Effect.sync(() => {
              logical.pendingOperations--
            }))
          )
        })

      const settle = Effect.fnUntraced(
        function*(message: Message, method: Protocol.MethodDescriptor, multiple = false, requeue = false) {
          const capability = yield* Effect.fromResult(settlements.validate(logical, message))
          const origin = capability.origin
          const fields: Fields = { deliveryTag: capability.tag }
          if (method !== Protocol.BasicReject) fields.multiple = multiple
          if (method !== Protocol.BasicAck) fields.requeue = requeue
          const frame = yield* Codec.encodeMethod(origin.id, method, fields)
          const command = yield* Effect.suspend((): Effect.Effect<Write, Error> => {
            // Encoding may yield to another settler or retirement. Revalidate and commit in one turn.
            const valid = settlements.validate(logical, message)
            if (Result.isFailure(valid)) return Effect.fail(valid.failure)
            const result = submit(
              origin.epoch,
              [frame],
              false,
              origin,
              true,
              () => settlements.commit(origin, capability.tag, multiple)
            )
            return Effect.fromResult(result)
          })
          yield* Deferred.await(command.done)
        }
      )

      const settleAll = (method: Protocol.MethodDescriptor, requeue = false) =>
        operation(logical, (origin) =>
          Effect.gen(function*() {
            const frame = yield* Codec.encodeMethod(origin.id, method, {
              deliveryTag: BigInt(0),
              multiple: true,
              ...(method === Protocol.BasicNack ? { requeue } : {})
            })
            const command = yield* Effect.suspend((): Effect.Effect<Write, Error> => {
              if (origin.logical.closed || origin.closing || closing) {
                return Effect.fail(channelError("Channel is closed"))
              }
              return Effect.fromResult(
                submit(origin.epoch, [frame], false, origin, true, () => settlements.commit(origin, BigInt(0), true))
              )
            })
            yield* Deferred.await(command.done)
          }))

      const bind = (binding: DesiredTopology.Binding, remove: boolean) =>
        operation(logical, (origin) =>
          Effect.gen(function*() {
            const prepared = yield* topology.prepareBinding(logical, binding, remove)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(applyBinding(origin, prepared.binding, remove)).pipe(Effect.andThen(Effect.sync(prepared.commit)))
            )
          }))

      const channel: AMQPChannel.AMQPChannel = {
        [ChannelTypeId]: ChannelTypeId,
        connection,
        publish,
        sendToQueue: (queue, content, opts) => publish("", () => DesiredTopology.queueName(queue), content, opts),
        ack: (message, multiple) => settle(message, Protocol.BasicAck, multiple),
        nack: (message, multiple, requeue = true) => settle(message, Protocol.BasicNack, multiple, requeue),
        reject: (message, requeue = true) => settle(message, Protocol.BasicReject, false, requeue),
        ackAll: () => settleAll(Protocol.BasicAck),
        nackAll: (requeue = true) => settleAll(Protocol.BasicNack, requeue),
        assertQueue: (queue = "", opts = {}) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              const remembered = yield* DesiredTopology.snapshotOptions(opts)
              const reply = yield* declareQueue(origin, queue, remembered)
              return topology.queueDeclared(logical, queue, remembered, reply)
            })),
        checkQueue: (queue) =>
          operation(logical, (origin) => declareQueue(origin, DesiredTopology.queueName(queue), {}, true)),
        deleteQueue: (queue, opts = {}) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              const reply = yield* rpc(origin.epoch, origin, Protocol.QueueDelete, {
                reserved1: 0,
                queue: DesiredTopology.queueName(queue),
                ifUnused: opts.ifUnused ?? false,
                ifEmpty: opts.ifEmpty ?? false,
                noWait: false
              })
              topology.queueDeleted(queue)
              return { messageCount: yield* Protocol.readNumber(reply.method, "messageCount") }
            })),
        purgeQueue: (queue) =>
          operation(logical, (origin) =>
            rpc(origin.epoch, origin, Protocol.QueuePurge, {
              reserved1: 0,
              queue: DesiredTopology.queueName(queue),
              noWait: false
            }).pipe(
              Effect.flatMap((reply) =>
                Protocol.readNumber(reply.method, "messageCount").pipe(Effect.map((messageCount) => ({ messageCount })))
              )
            )),
        assertExchange: (exchange, type, opts = {}) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              const remembered = yield* DesiredTopology.snapshotOptions(opts)
              const declaration: DesiredTopology.ExchangeDeclaration = { exchange, type, options: remembered }
              yield* declareExchange(origin, declaration)
              topology.exchangeDeclared(logical, declaration)
            })),
        checkExchange: (exchange) =>
          operation(logical, (origin) =>
            rpc(origin.epoch, origin, Protocol.ExchangeDeclare, {
              reserved1: 0,
              exchange,
              type: "",
              passive: true,
              durable: false,
              autoDelete: false,
              internal: false,
              noWait: false,
              arguments: {}
            }).pipe(Effect.asVoid)),
        deleteExchange: (exchange, opts = {}) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              yield* rpc(origin.epoch, origin, Protocol.ExchangeDelete, {
                reserved1: 0,
                exchange,
                ifUnused: opts.ifUnused ?? false,
                noWait: false
              })
              topology.exchangeDeleted(exchange)
            })),
        bindQueue: (queue, exchange, routingKey, args = {}) =>
          bind({ queue, source: exchange, routingKey, arguments: args }, false),
        unbindQueue: (queue, exchange, routingKey, args = {}) =>
          bind({ queue, source: exchange, routingKey, arguments: args }, true),
        bindExchange: (destination, source, routingKey, args = {}) =>
          bind({ destination, source, routingKey, arguments: args }, false),
        unbindExchange: (destination, source, routingKey, args = {}) =>
          bind({ destination, source, routingKey, arguments: args }, true),
        consume: (queue, opts = {}) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              const prefetch = yield* integer("consumer prefetch", opts.prefetch ?? logical.prefetch, 1, 65535)
              const consumer: Consumer = {
                queue,
                options: yield* DesiredTopology.snapshotOptions(opts),
                mailbox: yield* Queue.make<Envelope<Message>, Error | Cause.Done>({
                  capacity: prefetch,
                  strategy: "dropping"
                }),
                tag: "",
                active: true
              }
              topology.addConsumer(logical, consumer)
              const unregister = Effect.sync(() => {
                consumer.active = false
                topology.removeConsumer(logical, consumer)
                discard(consumer.mailbox)
                Queue.endUnsafe(consumer.mailbox)
              })
              yield* startConsumer(origin, consumer).pipe(
                Effect.tapError(() => unregister),
                Effect.onInterrupt(() => unregister)
              )
              return mailboxStream(consumer.mailbox).pipe(Stream.ensuring(
                cancelConsumer(logical, consumer).pipe(
                  Effect.interruptible,
                  Effect.timeout(shutdownTimeout),
                  Effect.ignore
                )
              ))
            })),
        cancel: (tag) =>
          operation(logical, (origin) => {
            const consumer = Array.from(topology.consumers(logical)).find((item) => item.tag === tag)
            return consumer === undefined
              ? rpc(origin.epoch, origin, Protocol.BasicCancel, { consumerTag: tag, noWait: false }).pipe(Effect.asVoid)
              : cancelConsumer(logical, consumer)
          }),
        get: (queue) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              if (settlements.count(origin) >= maxPending) {
                return yield* channelError("Unsettled delivery limit exceeded")
              }
              const reply = yield* rpc(origin.epoch, origin, Protocol.BasicGet, {
                reserved1: 0,
                queue: DesiredTopology.queueName(queue),
                noAck: false
              })
              return reply.message === undefined ? Option.none() : Option.some(reply.message)
            })),
        prefetch: (count, global = false) =>
          operation(logical, (origin) =>
            Effect.gen(function*() {
              yield* integer("prefetch", count, 1, 65535)
              yield* rpc(origin.epoch, origin, Protocol.BasicQos, { prefetchSize: 0, prefetchCount: count, global })
              if (global) logical.globalPrefetch = count
              else logical.prefetch = count
            })),
        recover: () =>
          operation(logical, (origin) =>
            rpc(origin.epoch, origin, Protocol.BasicRecover, { requeue: true }, connectionTimeout, () => {
              // Revoke atomically with admission, before the reader can receive any redelivery.
              settlements.revokeAll(origin)
              for (const consumer of topology.consumers(logical)) {
                discard(consumer.mailbox)
              }
            }).pipe(Effect.asVoid)),
        returns: mailboxStream(logical.returned),
        close: closeLogical(logical)
      }
      return channel
    })

    const close = Effect.gen(function*() {
      if (closing) {
        return yield* Deferred.await(closeDone)
      }
      const epoch = current ?? brokerClosing
      closing = true
      yield* setState({ state: "Closing", generation })
      yield* Effect.gen(function*() {
        for (const logical of Array.from(logicals)) {
          yield* closeLogical(logical)
        }
        if (epoch !== undefined && epoch.active) {
          if (epoch.brokerCloseError === undefined) {
            yield* rpc(
              epoch,
              undefined,
              Protocol.ConnectionClose,
              {
                replyCode: 200,
                replyText: "Goodbye",
                classId: 0,
                methodId: 0
              },
              shutdownTimeout
            ).pipe(Effect.ignore)
          }
          // This wait shares the existing global shutdown deadline; it cannot extend shutdown.
          yield* awaitBrokerClose(epoch)
        }
      }).pipe(Effect.interruptible, Effect.timeout(shutdownTimeout), Effect.ignore)
      if (epoch !== undefined) {
        failEpoch(epoch, connectionError("Connection closed", undefined, true))
      }
      // A global shutdown deadline may have interrupted the channel loop. Retired sessions make this cleanup local.
      for (const logical of Array.from(logicals)) {
        yield* closeLogical(logical)
      }
      yield* Fiber.interrupt(supervisorFiber)
      terminal = connectionError("Connection is closed", undefined, true)
      ready.openUnsafe()
      yield* setState({ state: "Closed", generation })
    }).pipe(
      Effect.uninterruptible,
      Effect.ensuring(Effect.sync(() =>
        finish(closeDone, Effect.void)
      ))
    )

    connection = {
      [ConnectionTypeId]: ConnectionTypeId,
      createChannel,
      serverProperties: awaitEpoch.pipe(Effect.map((epoch) => epoch.serverProperties)),
      state: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      awaitReady: awaitEpoch.pipe(Effect.asVoid),
      reconnect: Effect.gen(function*() {
        const epoch = yield* awaitEpoch
        failEpoch(epoch, connectionError("Explicit reconnect requested"))
        yield* awaitEpoch
      }),
      updateSecret: (newSecret, reason) =>
        Effect.gen(function*() {
          const epoch = yield* awaitEpoch
          yield* rpc(epoch, undefined, Protocol.ConnectionUpdateSecret, {
            newSecret: Redacted.isRedacted(newSecret) ? Redacted.value(newSecret) : newSecret,
            reason
          })
          secret = newSecret
        }),
      close
    }
    yield* Effect.addFinalizer(() => close)
    yield* connection.awaitReady.pipe(Effect.tapError(() => close), Effect.onInterrupt(() => close))
    return connection
  })
