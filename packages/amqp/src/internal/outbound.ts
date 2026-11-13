import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Result from "effect/Result"
import * as AMQPError from "../AMQPError.ts"

type AMQPFailure = AMQPError.AMQPError

/** An admission token charges memory before content framing allocates it. @internal */
export interface Reservation {
  readonly bytes: number
  readonly publish: boolean
  readonly priority: boolean
  readonly owner?: object
  state: "Reserved" | "Queued" | "Writing" | "Released"
}

/** Writer-owned, indivisible content sequence. @internal */
export interface WriteCommand<Physical> {
  readonly frames: Array<Uint8Array>
  readonly reservation: Reservation
  readonly done: Deferred.Deferred<void, AMQPFailure>
  readonly drained: Deferred.Deferred<void>
  readonly publish: boolean
  readonly priority: boolean
  readonly channel: number
  readonly physical?: Physical
  started: boolean
  cancelled: boolean
}

/** Connection-wide admission, scheduling and lifetime accounting. @internal */
export const make = <Physical extends object>(options: {
  readonly maxBytes: number
  readonly maxCommands: number
  readonly frameMax: () => number
  readonly isActive: () => boolean
  readonly isWritable: (command: WriteCommand<Physical>) => boolean
  readonly validate: (command: WriteCommand<Physical>) => AMQPFailure | undefined
}) => {
  const wake = Latch.makeUnsafe()
  const control: Array<WriteCommand<Physical>> = []
  const data: Array<WriteCommand<Physical>> = []
  const reservations = new Set<Reservation>()
  let writing: WriteCommand<Physical> | undefined
  let bytes = 0
  let count = 0

  const release = (reservation: Reservation): void => {
    if (!reservations.delete(reservation)) return
    reservation.state = "Released"
    bytes -= reservation.bytes
    count--
  }
  const reserve = (request: {
    readonly bytes: number
    readonly publish?: boolean
    readonly priority?: boolean
    readonly owner?: Physical | undefined
  }): Result.Result<Reservation, AMQPFailure> => {
    const publish = request.publish === true
    const priority = request.priority === true
    const reason = !options.isActive() ?
      "Session retired before write admission" :
      !Number.isSafeInteger(request.bytes) || request.bytes < 0 ?
      "Invalid outbound reservation" :
      count >= options.maxCommands + (priority ? 16 : 0) ||
        bytes + request.bytes > options.maxBytes + (priority ? 65536 : 0)
      ? "Outbound admission limit exceeded" :
      undefined
    if (reason !== undefined) {
      return Result.fail(
        publish
          ? new AMQPError.AMQPPublishError({ outcome: "NotSent", reason })
          : new AMQPError.AMQPChannelError({ reason })
      )
    }
    const reservation: Reservation = {
      bytes: request.bytes,
      publish,
      priority,
      state: "Reserved",
      ...(request.owner === undefined ? {} : { owner: request.owner })
    }
    reservations.add(reservation)
    bytes += request.bytes
    count++
    return Result.succeed(reservation)
  }
  const commit = (request: {
    readonly reservation: Reservation
    readonly frames: Array<Uint8Array>
    readonly channel: number
    readonly physical?: Physical | undefined
    readonly onAdmitted?: (() => void) | undefined
  }): Result.Result<WriteCommand<Physical>, AMQPFailure> => {
    const token = request.reservation
    const fail = (error: AMQPFailure) => {
      request.frames.length = 0
      release(token)
      return Result.fail(error)
    }
    if (!reservations.has(token) || token.state !== "Reserved") {
      return Result.fail(new AMQPError.AMQPChannelError({ reason: "Outbound reservation is no longer valid" }))
    }
    let actualBytes = 0
    for (const frame of request.frames) {
      if (frame.byteLength > options.frameMax()) {
        return fail(new AMQPError.AMQPProtocolError({ reason: "Encoded frame exceeds negotiated frameMax" }))
      }
      actualBytes += frame.byteLength
    }
    if (request.frames.length === 0 || actualBytes !== token.bytes) {
      return fail(new AMQPError.AMQPProtocolError({ reason: "Outbound framing does not match reservation" }))
    }
    const command: WriteCommand<Physical> = {
      frames: request.frames,
      reservation: token,
      done: Deferred.makeUnsafe(),
      drained: Deferred.makeUnsafe(),
      publish: token.publish,
      priority: token.priority,
      channel: request.channel,
      ...(request.physical === undefined ? {} : { physical: request.physical }),
      started: false,
      cancelled: false
    }
    const error = options.validate(command)
    if (error !== undefined) return fail(error)
    token.state = "Queued"
    const queue = token.priority ? control : data
    queue.push(command)
    request.onAdmitted?.()
    wake.openUnsafe()
    return Result.succeed(command)
  }
  const complete = (command: WriteCommand<Physical>, completion: Effect.Effect<void, AMQPFailure>): void => {
    // Waiting publishers may retain the command until confirm. Drop encoded content
    // before returning its budget or synchronously resuming any waiter.
    command.frames.length = 0
    release(command.reservation)
    if (writing === command) writing = undefined
    Deferred.doneUnsafe(command.drained, Effect.void)
    Deferred.doneUnsafe(command.done, completion)
  }
  const commands = () => [...control, ...data, ...(writing === undefined ? [] : [writing])]
  const retire = (request: {
    readonly matches?: (command: WriteCommand<Physical>) => boolean
    readonly owner?: Physical
    readonly error: (command: WriteCommand<Physical>) => AMQPFailure
  }): void => {
    for (const queue of [control, data]) {
      for (let index = queue.length - 1; index >= 0; index--) {
        const command = queue[index]
        if (command === undefined || (request.matches !== undefined && !request.matches(command))) continue
        queue.splice(index, 1)
        command.cancelled = true
        complete(command, Effect.fail(request.error(command)))
      }
    }
    if (writing !== undefined && (request.matches === undefined || request.matches(writing))) {
      // A channel-only retirement must keep charging a backpressured writer's retained frames.
      // Session retirement also retains ownership until the writer's cancellation finalizer runs.
      Deferred.doneUnsafe(writing.done, Effect.fail(request.error(writing)))
    }
    for (const token of reservations) {
      if (
        (request.matches === undefined && token.state === "Reserved") ||
        (token.state === "Reserved" && request.owner !== undefined && token.owner === request.owner)
      ) {
        release(token)
      }
    }
    wake.openUnsafe()
  }
  const run = Effect.fnUntraced(
    function*(
      write: (command: WriteCommand<Physical>) => Effect.Effect<void, AMQPFailure>
    ) {
      while (options.isActive()) {
        let command = control.shift()
        if (command === undefined) {
          const index = data.findIndex((item) => item.cancelled || options.isWritable(item))
          if (index >= 0) command = data.splice(index, 1)[0]
        }
        if (command === undefined) {
          wake.closeUnsafe()
          yield* wake.await
          continue
        }
        writing = command
        command.reservation.state = "Writing"
        const error = options.validate(command)
        if (command.cancelled || error !== undefined) {
          complete(command, Effect.fail(error ?? new AMQPError.AMQPChannelError({ reason: "Write cancelled" })))
        } else {
          command.started = true
          const result = yield* Effect.exit(write(command))
          complete(command, Exit.isSuccess(result) ? Effect.void : Effect.failCause(result.cause))
        }
      }
    },
    Effect.ensuring(Effect.sync(() => {
      retire({
        error: (command) =>
          command.publish
            ? new AMQPError.AMQPPublishError({
              reason: "Outbound writer retired",
              outcome: command.started ? "Unknown" : "NotSent"
            })
            : new AMQPError.AMQPChannelError({ reason: "Outbound writer retired" })
      })
      if (writing !== undefined) {
        complete(writing, Effect.fail(new AMQPError.AMQPChannelError({ reason: "Outbound writer retired" })))
      }
    }))
  )
  return {
    reserve,
    commit,
    cancel: (token: Reservation): void => {
      if (token.state === "Reserved") release(token)
    },
    cancelCommand: (command: WriteCommand<Physical>): void => {
      if (command.reservation.state !== "Queued") return
      const queue = command.priority ? control : data
      const index = queue.indexOf(command)
      if (index < 0) return
      queue.splice(index, 1)
      command.cancelled = true
      complete(command, Effect.fail(new AMQPError.AMQPChannelError({ reason: "Write cancelled" })))
    },
    retire,
    run,
    wake,
    drain: (channel: number) =>
      Effect.suspend(() =>
        Effect.forEach(
          commands().filter((command) => command.channel === channel),
          (command) => Deferred.await(command.drained),
          { discard: true }
        )
      ),
    usage: () => ({ bytes, commands: count })
  }
}
