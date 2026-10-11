/**
 * @since 0.1.0
 */
import * as Headers from "effect/http/Headers"
import * as HttpTraceContext from "effect/http/HttpTraceContext"
import * as Option from "effect/Option"
import type * as Tracer from "effect/Tracer"

/** @since 0.1.0 */
export const Match = { Exact: "exact", CanonicalMIME: "canonical", IgnoreCase: "insensitive" } as const
/** @since 0.1.0 */
export type Match = typeof Match[keyof typeof Match]
/** @since 0.1.0 */
export interface MsgHdrs extends Iterable<[string, Array<string>]> {
  readonly hasError: boolean
  readonly status: string
  readonly code: number
  readonly description: string
  get(key: string, match?: Match): string
  last(key: string, match?: Match): string
  set(key: string, value: string, match?: Match): void
  append(key: string, value: string, match?: Match): void
  has(key: string, match?: Match): boolean
  keys(): Array<string>
  values(key: string, match?: Match): Array<string>
  delete(key: string, match?: Match): void
}
/** @since 0.1.0 */
export const canonicalMIMEHeaderKey = (key: string): string => {
  if (/[^\x21-\x39\x3b-\x7e]/.test(key)) throw new Error("Invalid header name")
  return key.toLowerCase().replace(/(^|-)[a-z]/g, (value) => value.toUpperCase())
}
/** @since 0.1.0 */
export class MsgHdrsImpl implements MsgHdrs {
  private readonly fields = new Map<string, Array<string>>()
  readonly code: number
  readonly description: string
  constructor(code = 0, description = "") {
    this.code = code
    this.description = description
  }
  [Symbol.iterator](): IterableIterator<[string, Array<string>]> {
    return this.fields.entries()
  }
  size(): number {
    return this.fields.size
  }
  get hasError(): boolean {
    return this.code >= 300
  }
  get status(): string {
    return `${this.code} ${this.description}`.trim()
  }
  keys(): Array<string> {
    return Array.from(this.fields.keys())
  }
  findKeys(key: string, match: Match = Match.Exact): Array<string> {
    const canonical = match === Match.CanonicalMIME ? canonicalMIMEHeaderKey(key) : key
    return this.keys().filter((stored) =>
      match === Match.IgnoreCase
        ? stored.toLowerCase() === key.toLowerCase()
        : stored === canonical
    )
  }
  values(key: string, match?: Match): Array<string> {
    return this.findKeys(key, match).flatMap((stored) => this.fields.get(stored) ?? [])
  }
  get(key: string, match?: Match): string {
    return this.fields.get(this.findKeys(key, match)[0] ?? "")?.[0] ?? ""
  }
  last(key: string, match?: Match): string {
    return this.fields.get(this.findKeys(key, match)[0] ?? "")?.at(-1) ?? ""
  }
  has(key: string, match?: Match): boolean {
    return this.findKeys(key, match).length > 0
  }
  delete(key: string, match?: Match): void {
    for (const stored of this.findKeys(key, match)) this.fields.delete(stored)
  }
  set(key: string, value: string, match?: Match): void {
    this.delete(key, match)
    this.append(key, value, match)
  }
  append(key: string, value: string, match: Match = Match.Exact): void {
    const canonical = canonicalMIMEHeaderKey(key)
    const normalized = MsgHdrsImpl.validHeaderValue(value)
    const stored = this.findKeys(key, match)[0] ?? (match === Match.CanonicalMIME ? canonical : key)
    const values = this.fields.get(stored) ?? []
    values.push(normalized)
    this.fields.set(stored, values)
  }
  equals(other: MsgHdrs): boolean {
    return this.code === other.code && this.size() === other.keys().length && this.keys().every((key) => {
      const left = this.values(key).sort()
      const right = other.values(key).sort()
      return left.length === right.length && left.every((value, index) => value === right[index])
    })
  }
  toRecord(): Record<string, Array<string>> {
    return Object.fromEntries(this.keys().map((key) => [key, this.values(key)]))
  }
  toString(): string {
    if (this.size() === 0 && this.code === 0) return ""
    const status = this.code > 0 && this.description !== "" ? ` ${this.code} ${this.description}` : ""
    const lines = Array.from(this).flatMap(([key, values]) => values.map((value) => `${key}: ${value}`))
    return [`NATS/1.0${status}`, ...lines, "", ""].join("\r\n")
  }
  encode(): Uint8Array {
    return new TextEncoder().encode(this.toString())
  }
  static validHeaderValue(value: string): string {
    if (/[\r\n]/.test(value)) throw new Error("Header values cannot contain CR or LF")
    return value.trim()
  }
  static fromRecord(record: Record<string, Array<string> | string | number | boolean>): MsgHdrsImpl {
    const result = new MsgHdrsImpl()
    for (const [key, values] of Object.entries(record)) {
      for (const value of Array.isArray(values) ? values : [String(values)]) result.append(key, value)
    }
    return result
  }
  static decode(bytes: Uint8Array): MsgHdrsImpl {
    if (bytes.length === 0) return new MsgHdrsImpl()
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (!text.endsWith("\r\n\r\n")) throw new Error("NATS header block missing terminator")
    const lines = text.split("\r\n")
    const match = /^NATS\/1\.0(?:\s+(\d+)(?:\s+(.*))?)?\s*$/.exec(lines.shift() ?? "")
    if (!match) throw new Error("Invalid NATS header preamble")
    const result = new MsgHdrsImpl(match[1] === undefined ? 0 : Number(match[1]), match[2] ?? "")
    for (const line of lines) {
      if (line === "") continue
      const colon = line.indexOf(":")
      if (colon < 0) continue
      result.append(line.slice(0, colon), line.slice(colon + 1))
    }
    return result
  }
}
/** @since 0.1.0 */
export const headers = (code = 0, description = ""): MsgHdrsImpl => {
  if ((code === 0) !== (description === "")) throw new Error("Header status requires code and description")
  return new MsgHdrsImpl(code, description)
}

/** @internal */
export const natsHeadersToEffectHeaders = (msgHdrs: MsgHdrs): Headers.Headers => {
  const entries: Array<[string, string]> = []
  for (const [key, values] of msgHdrs) {
    for (const value of values) {
      entries.push([key, value])
    }
  }
  return Headers.fromInput(entries)
}

/** @internal */
export const effectHeadersToNatsHeaders = (hdrs: Headers.Headers): MsgHdrs => {
  const msgHdrs = headers()
  for (const [key, value] of Object.entries(hdrs)) {
    if (key !== Headers.TypeId.toString()) {
      msgHdrs.set(key, value)
    }
  }
  return msgHdrs
}

/** @internal */
export const mergeNatsHeaders = (
  existing: MsgHdrs | undefined,
  toMerge: MsgHdrs
): MsgHdrs => {
  const result = existing ?? headers()
  for (const [key, values] of toMerge) {
    for (const value of values) {
      result.append(key, value)
    }
  }
  return result
}

/** @internal */
export const encodeTraceContext = (span: Tracer.Span): MsgHdrs => {
  const traceHeaders = HttpTraceContext.toHeaders(span)
  return effectHeadersToNatsHeaders(traceHeaders)
}

/** @internal */
export const decodeTraceContext = (msgHdrs: MsgHdrs): Option.Option<Tracer.ExternalSpan> => {
  const effectHeaders = natsHeadersToEffectHeaders(msgHdrs)
  return HttpTraceContext.fromHeaders(effectHeaders)
}

/** @internal */
export const decodeTraceContextOptional = (
  msgHdrs: Option.Option<MsgHdrs>
): Option.Option<Tracer.ExternalSpan> =>
  msgHdrs.pipe(
    Option.flatMap(decodeTraceContext)
  )
