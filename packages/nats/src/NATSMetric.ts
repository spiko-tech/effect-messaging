/**
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/** Benchmark measurement in milliseconds and wire bytes.
 * @since 0.1.0
 * @category models
 */
export const Metric = Schema.Struct({
  name: Schema.String,
  duration: Schema.Number,
  date: Schema.Number,
  payload: Schema.Number,
  msgs: Schema.Number,
  lang: Schema.String,
  version: Schema.String,
  bytes: Schema.Number,
  asyncRequests: Schema.optionalKey(Schema.Boolean),
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number)
})
/** @since 0.1.0 */
export interface Metric extends Schema.Schema.Type<typeof Metric> {}
/** @since 0.1.0 */
export const header = (): string => "Test,Date,Lang,Version,Count,MsgPayload,Bytes,Millis,Async\n"
/** @since 0.1.0 */
export const toCsv = (metric: Metric): string =>
  `"${metric.name}",${
    new Date(metric.date).toISOString()
  },${metric.lang},${metric.version},${metric.msgs},${metric.payload},${metric.bytes},${metric.duration},${
    metric.asyncRequests || false
  }\n`
/** @since 0.1.0 */
export const humanizeBytes = (bytes: number, si = false): string => {
  const base = si ? 1000 : 1024
  const units = si ? ["k", "M", "G", "T", "P", "E"] : ["K", "M", "G", "T", "P", "E"]
  const suffix = si ? "iB" : "B"
  if (bytes < base) return `${bytes.toFixed(2)} ${suffix}`
  const exponent = Math.floor(Math.log(bytes) / Math.log(base))
  return `${(bytes / Math.pow(base, exponent)).toFixed(2)} ${units[exponent - 1]}${suffix}`
}
/** @since 0.1.0 */
export const throughput = (bytes: number, seconds: number): string => `${humanizeBytes(bytes / seconds)}/sec`
/** @since 0.1.0 */
export const msgThroughput = (msgs: number, seconds: number): string => `${Math.floor(msgs / seconds)} msgs/sec`
/** @since 0.1.0 */
export const toString = (metric: Metric): string => {
  const seconds = metric.duration / 1000
  const rate = Math.round(metric.msgs / seconds).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${metric.name}${metric.asyncRequests ? " [asyncRequests]" : ""} ${rate} msgs/sec - [${
    seconds.toFixed(2)
  } secs] ~ ${throughput(metric.bytes, seconds)} ${metric.max ? `${metric.min}/${metric.max}` : ""}`
}
