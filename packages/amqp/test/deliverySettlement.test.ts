import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { AMQPProtocolError, AMQPSettlementError } from "../src/AMQPError.ts"
import * as DeliverySettlement from "../src/internal/deliverySettlement.ts"

interface Origin {
  readonly id: number
  readonly owner: object
  active: boolean
  epochActive: boolean
  closed: boolean
}

const setup = () => {
  const owner = {}
  const origin: Origin = { id: 1, owner, active: true, epochActive: true, closed: false }
  const ledger = DeliverySettlement.make<object, Origin, object>({
    ownerOf: (channel) => channel.owner,
    isActive: (channel) => channel.active && channel.epochActive && !channel.closed
  })
  const register = (tag: number, channel = origin) => {
    const message = {}
    return Result.map(ledger.register(channel, message, BigInt(tag)), () => message)
  }
  return { owner, origin, ledger, register }
}

const settlementError = (
  result: Result.Result<unknown, AMQPSettlementError>,
  kind: "Stale" | "AlreadySettled"
): void => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(AMQPSettlementError)
    expect(result.failure.kind).toBe(kind)
  }
}
const protocolError = (result: Result.Result<unknown, AMQPProtocolError>): void => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(AMQPProtocolError)
}

describe("delivery settlement ownership", () => {
  it.effect("binds authority to object identity and owner, not copied message fields", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const message = yield* Effect.fromResult(register(1))
      expect(yield* Effect.fromResult(ledger.validate(owner, message))).toEqual({ origin, tag: BigInt(1) })
      expect(Object.isFrozen(yield* Effect.fromResult(ledger.validate(owner, message)))).toBe(true)
      settlementError(ledger.validate({}, message), "Stale")
      settlementError(ledger.validate(owner, { ...message }), "Stale")
      expect(ledger.count(origin)).toBe(1)
    }))

  it.effect("never routes old messages onto a replacement physical channel with the same ID", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const oldMessage = yield* Effect.fromResult(register(1))
      ledger.retire(origin)
      const replacement = { ...origin }
      const newMessage = yield* Effect.fromResult(register(1, replacement))
      settlementError(ledger.validate(owner, oldMessage), "Stale")
      expect((yield* Effect.fromResult(ledger.validate(owner, newMessage))).origin).toBe(replacement)
      expect(ledger.count(origin)).toBe(0)
      expect(ledger.count(replacement)).toBe(1)
      protocolError(register(2))
    }))

  it.effect("checks physical, epoch and logical lifetime before duplicate settlement", () =>
    Effect.gen(function*() {
      for (const field of ["active", "epochActive", "closed"] as const) {
        const { ledger, origin, owner, register } = setup()
        const message = yield* Effect.fromResult(register(1))
        ledger.commit(origin, BigInt(1))
        settlementError(ledger.validate(owner, message), "AlreadySettled")
        origin[field] = field === "closed"
        settlementError(ledger.validate(owner, message), "Stale")
      }
    }))

  it.effect("tracks deliveries received during logical shutdown until physical retirement", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      origin.closed = true
      const message = yield* Effect.fromResult(register(1))
      settlementError(ledger.validate(owner, message), "Stale")
      expect(ledger.revoke(message)).toEqual({ origin, tag: BigInt(1) })
      expect(ledger.count(origin)).toBe(0)
      ledger.retire(origin)
      protocolError(register(2))
    }))

  it.effect("commits only the selected tag unless multiple is requested", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const first = yield* Effect.fromResult(register(1))
      const second = yield* Effect.fromResult(register(2))
      const third = yield* Effect.fromResult(register(3))
      ledger.commit(origin, BigInt(2))
      settlementError(ledger.validate(owner, second), "AlreadySettled")
      expect((yield* Effect.fromResult(ledger.validate(owner, first))).tag).toBe(BigInt(1))
      expect((yield* Effect.fromResult(ledger.validate(owner, third))).tag).toBe(BigInt(3))
      expect(ledger.count(origin)).toBe(2)
      ledger.commit(origin, BigInt(3), true)
      settlementError(ledger.validate(owner, first), "AlreadySettled")
      settlementError(ledger.validate(owner, third), "AlreadySettled")
      expect(ledger.count(origin)).toBe(0)
    }))

  it.effect("multiple settlement excludes revoked lower tags and other physical channels", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const first = yield* Effect.fromResult(register(1))
      const second = yield* Effect.fromResult(register(2))
      const third = yield* Effect.fromResult(register(3))
      const other = { ...origin }
      const otherMessage = yield* Effect.fromResult(register(1, other))
      expect(ledger.revoke(first)).toEqual({ origin, tag: BigInt(1) })
      expect(ledger.revoke(first)).toBeUndefined()
      ledger.commit(origin, BigInt(2), true)
      settlementError(ledger.validate(owner, first), "Stale")
      settlementError(ledger.validate(owner, second), "AlreadySettled")
      expect((yield* Effect.fromResult(ledger.validate(owner, third))).tag).toBe(BigInt(3))
      expect((yield* Effect.fromResult(ledger.validate(owner, otherMessage))).origin).toBe(other)
      expect(ledger.count(origin)).toBe(1)
      expect(ledger.count(other)).toBe(1)
    }))

  it.effect("zero with multiple commits all outstanding deliveries without changing revoked history", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const revoked = yield* Effect.fromResult(register(1))
      const first = yield* Effect.fromResult(register(2))
      const second = yield* Effect.fromResult(register(3))
      ledger.revoke(revoked)
      ledger.commit(origin, BigInt(0), true)
      settlementError(ledger.validate(owner, revoked), "Stale")
      settlementError(ledger.validate(owner, first), "AlreadySettled")
      settlementError(ledger.validate(owner, second), "AlreadySettled")
      expect(ledger.revoke(first)).toBeUndefined()
      expect(ledger.revoke({})).toBeUndefined()
      expect(ledger.count(origin)).toBe(0)
    }))

  it.effect("leaves deliveries retryable when command admission fails before commit", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const message = yield* Effect.fromResult(register(1))
      const submit = (): Result.Result<void, AMQPProtocolError> =>
        Result.fail(new AMQPProtocolError({ reason: "Admission failed" }))
      const admission = Result.flatMap(ledger.validate(owner, message), (capability) =>
        Result.map(submit(), () => ledger.commit(capability.origin, capability.tag)))
      expect(Result.isFailure(admission)).toBe(true)
      if (Result.isFailure(admission)) {
        expect(admission.failure).toBeInstanceOf(AMQPProtocolError)
        expect(admission.failure.reason).toBe("Admission failed")
      }
      expect((yield* Effect.fromResult(ledger.validate(owner, message))).tag).toBe(BigInt(1))
      expect(ledger.count(origin)).toBe(1)
      ledger.commit(origin, BigInt(1))
      settlementError(ledger.validate(owner, message), "AlreadySettled")
    }))

  it.effect("recovery revokes only outstanding entries and preserves increasing tag history", () =>
    Effect.gen(function*() {
      const { ledger, origin, owner, register } = setup()
      const settled = yield* Effect.fromResult(register(1))
      ledger.commit(origin, BigInt(1))
      const outstanding = yield* Effect.fromResult(register(2))
      ledger.revokeAll(origin)
      settlementError(ledger.validate(owner, settled), "AlreadySettled")
      settlementError(ledger.validate(owner, outstanding), "Stale")
      expect(ledger.count(origin)).toBe(0)
      protocolError(register(2))
      const next = yield* Effect.fromResult(register(3))
      expect((yield* Effect.fromResult(ledger.validate(owner, next))).tag).toBe(BigInt(3))
      expect(ledger.count(origin)).toBe(1)
    }))

  it.effect("rejects zero, decreasing and reused tags even after immediate revocation", () =>
    Effect.gen(function*() {
      const { ledger, origin, register } = setup()
      protocolError(register(0))
      const message = yield* Effect.fromResult(register(4))
      ledger.revoke(message)
      protocolError(register(3))
      protocolError(register(4))
      yield* Effect.fromResult(register(5))
      expect(ledger.count(origin)).toBe(1)
      protocolError(ledger.register(origin, message, BigInt(6)))
      yield* Effect.fromResult(register(6))
      expect(ledger.count(origin)).toBe(2)
    }))
})
