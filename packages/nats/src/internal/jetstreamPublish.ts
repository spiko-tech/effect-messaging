/** @internal */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as T from "../JetStreamTypes.ts"
import * as NATSHeaders from "../NATSHeaders.ts"
import * as Api from "./jetstreamApi.ts"

const EveryDuration = Schema.String.check(
  Schema.isPattern(/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/)
)
const intervalMilliseconds = (value: string) => {
  Schema.decodeUnknownSync(EveryDuration)(value.trim())
  const scales: Record<string, number> = { ns: 0.000001, us: 0.001, µs: 0.001, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  return Array.from(value.trim().matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)).reduce(
    (total, match) => total + Number(match[1]) * (scales[match[2] ?? ""] ?? 0),
    0
  )
}
const scheduleSpec = (spec: T.ScheduleOptions["specification"]): string => {
  if (typeof spec === "string") return spec
  if (spec instanceof Date) return `@at ${spec.toISOString()}`
  if ("at" in spec) return `@at ${spec.at instanceof Date ? spec.at.toISOString() : spec.at}`
  if ("every" in spec) {
    if (intervalMilliseconds(spec.every) < 1000) throw new Error("@every interval must be at least 1s")
    return `@every ${spec.every}`
  }
  if ("cron" in spec) return spec.cron
  return spec.predefined
}
/** @internal */
export const publishHeaders = (options: Partial<T.JetStreamPublishOptions>) =>
  Effect.try({
    try: () => {
      const headers = NATSHeaders.mergeNatsHeaders(undefined, options.headers ?? NATSHeaders.headers())
      const expect = options.expect ?? {}
      const values: Record<string, string | number | undefined> = {
        "Nats-Msg-Id": options.msgID,
        "Nats-Expected-Stream": expect.streamName,
        "Nats-Expected-Last-Msg-Id": expect.lastMsgID,
        "Nats-Expected-Last-Sequence": expect.lastSequence,
        "Nats-Expected-Last-Subject-Sequence": expect.lastSubjectSequence,
        "Nats-Expected-Last-Subject-Sequence-Subject": expect.lastSubjectSequenceSubject,
        "Nats-Expected-Last-Subject-Sequence-Value": expect.lastSubjectSequenceValue,
        "Nats-TTL": options.ttl
      }
      for (const [key, value] of Object.entries(values)) if (value !== undefined) headers.set(key, String(value))
      if (options.schedule && options.cancelSchedule) throw new Error("schedule and cancelSchedule are exclusive")
      if (options.schedule) {
        const schedule = options.schedule
        headers.set("Nats-Schedule", scheduleSpec(schedule.specification))
        headers.set("Nats-Schedule-Target", schedule.target)
        if (schedule.source) headers.set("Nats-Schedule-Source", schedule.source)
        if (schedule.ttl) headers.set("Nats-Schedule-TTL", schedule.ttl)
        if (schedule.timezone) headers.set("Nats-Schedule-Time-Zone", schedule.timezone)
        if (schedule.rollup) headers.set("Nats-Schedule-Rollup", schedule.rollup)
      }
      if (options.cancelSchedule) {
        headers.set("Nats-Scheduler", options.cancelSchedule.scheduleSubject)
        headers.set("Nats-Schedule-Next", "purge")
      }
      return headers
    },
    catch: (cause) => new Api.JetStreamApiError({ reason: "Invalid JetStream publish options", cause })
  })
