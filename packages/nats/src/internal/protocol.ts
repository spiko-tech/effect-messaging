/** @internal */
import * as Schema from "effect/Schema"
import * as NATSHeaders from "../NATSHeaders.ts"
import * as NATSOptions from "../NATSOptions.ts"

/** @internal */
export class NATSProtocolError extends Schema.TaggedError<NATSProtocolError>()("NATSProtocolError", {
  message: Schema.String
}) {}
/** @internal */
export type Frame =
  | { readonly _tag: "Info"; readonly info: NATSOptions.ServerInfoUpdate }
  | { readonly _tag: "Ping" | "Pong" | "Ok" }
  | { readonly _tag: "Error"; readonly message: string }
  | {
    readonly _tag: "Message"
    readonly subject: string
    readonly sid: number
    readonly reply?: string
    readonly data: Uint8Array
    readonly wireBytes: number
    readonly headers?: NATSHeaders.MsgHdrs
  }
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const invalid = (message: string): never => {
  throw new NATSProtocolError({ message })
}
const integer = (value: string): number => {
  if (value.length > 15 || !/^\d+$/.test(value)) return invalid("Invalid protocol integer")
  const result = Number(value)
  if (!Number.isSafeInteger(result)) return invalid("Protocol integer exceeds safe range")
  return result
}
const subjectToken = (subject: string): void => {
  if (subject.length === 0 || (/\s/.test(subject) || subject.includes(String.fromCharCode(0)))) {
    invalid("Invalid subject token")
  }
}
/** @internal */
export const encodeCommand = (command: string): Uint8Array => encoder.encode(command)
/** @internal */
export const encodePublish = (
  subject: string,
  payload: Uint8Array,
  options?: NATSOptions.PublishOptions
): Uint8Array => {
  subjectToken(subject)
  if (options?.reply !== undefined) subjectToken(options.reply)
  const headers = options?.headers
  // The v3.4 official client treats either boolean as opting into trace-only:
  // presence enables the header, including traceOnly: false.
  const traceOnly = typeof options?.traceOnly === "boolean"
  const headerBytes = headers === undefined && !traceOnly && options?.traceDestination === undefined
    ? undefined
    : new NATSHeaders.MsgHdrsImpl(headers?.code, headers?.description)
  if (headerBytes !== undefined && headers !== undefined) {
    for (const [key, values] of headers) for (const value of values) headerBytes.append(key, value)
  }
  if (traceOnly) headerBytes?.set("Nats-Trace-Only", "true")
  if (options?.traceDestination !== undefined) {
    subjectToken(options.traceDestination)
    headerBytes?.set("Nats-Trace-Dest", options.traceDestination)
  }
  const encodedHeaders = headerBytes?.encode() ?? new Uint8Array()
  const reply = options?.reply === undefined ? "" : `${options.reply} `
  const size = encodedHeaders.length + payload.length
  const command = headerBytes !== undefined
    ? `HPUB ${subject} ${reply}${encodedHeaders.length} ${size}\r\n`
    : `PUB ${subject} ${reply}${payload.length}\r\n`
  const prefix = encoder.encode(command)
  const result = new Uint8Array(prefix.length + size + 2)
  result.set(prefix)
  result.set(encodedHeaders, prefix.length)
  result.set(payload, prefix.length + encodedHeaders.length)
  result.set([13, 10], result.length - 2)
  return result
}
/** @internal */
export class Parser {
  private buffer = new Uint8Array(4096)
  private used = 0
  private pending: {
    subject: string
    sid: number
    reply?: string
    size: number
    headerSize: number
  } | undefined
  readonly maxControlLine: number
  readonly maxPayload: number
  constructor(options: { maxControlLine?: number; maxPayload?: number } = {}) {
    this.maxControlLine = options.maxControlLine ?? 4096
    this.maxPayload = options.maxPayload ?? 64 * 1024 * 1024
  }
  feed(chunk: Uint8Array): Array<Frame> {
    const needed = this.used + chunk.length
    if (needed > this.buffer.length) {
      const grown = new Uint8Array(Math.max(needed, this.buffer.length * 2))
      grown.set(this.buffer.subarray(0, this.used))
      this.buffer = grown
    }
    this.buffer.set(chunk, this.used)
    this.used = needed
    const frames: Array<Frame> = []
    let offset = 0
    while (offset < this.used) {
      if (this.pending !== undefined) {
        const pending = this.pending
        if (this.used - offset < pending.size + 2) break
        if (this.buffer[offset + pending.size] !== 13 || this.buffer[offset + pending.size + 1] !== 10) {
          return invalid("Message payload missing CRLF")
        }
        const headers = pending.headerSize === 0 ? undefined : NATSHeaders.MsgHdrsImpl.decode(
          this.buffer.subarray(offset, offset + pending.headerSize)
        )
        frames.push({
          _tag: "Message",
          subject: pending.subject,
          sid: pending.sid,
          ...(pending.reply === undefined ? {} : { reply: pending.reply }),
          data: this.buffer.slice(offset + pending.headerSize, offset + pending.size),
          wireBytes: pending.size,
          ...(headers === undefined ? {} : { headers })
        })
        offset += pending.size + 2
        this.pending = undefined
        continue
      }
      let end = offset
      while (end < this.used && this.buffer[end] !== 10) end++
      if (end >= this.used) {
        if (this.used - offset > this.maxControlLine) return invalid("Control line exceeds limit")
        const prefix = this.buffer.subarray(offset, this.used)
        const space = prefix.findIndex((byte) => byte === 32 || byte === 9 || byte === 13 || byte === 10)
        const command = decoder.decode(space < 0 ? prefix : prefix.subarray(0, space)).toUpperCase()
        if (
          command === "" ||
          !["MSG", "HMSG", "PING", "PONG", "+OK", "-ERR", "INFO"].some((valid) =>
            valid.startsWith(command) || valid === command || (valid === "+OK" && command.startsWith(valid))
          )
        ) return invalid("Unknown protocol command")
        break
      }
      if (end - offset > this.maxControlLine) return invalid("Control line exceeds limit")
      const line = decoder.decode(this.buffer.subarray(offset, end)).trimEnd()
      offset = end + 1
      const upperLine = line.toUpperCase().trimEnd()
      if (upperLine === "PING") frames.push({ _tag: "Ping" })
      else if (upperLine === "PONG") frames.push({ _tag: "Pong" })
      else if (upperLine.startsWith("+OK")) frames.push({ _tag: "Ok" })
      else if (upperLine.startsWith("-ERR ")) {
        frames.push({ _tag: "Error", message: line.slice(5).replace(/^'|'$/g, "") })
      } else if (upperLine.startsWith("INFO ")) {
        const info = Schema.decodeUnknownSync(NATSOptions.ServerInfoUpdate)(JSON.parse(line.slice(5)))
        frames.push({ _tag: "Info", info })
      } else {
        const tokens = line.trim().split(/[ \t]+/)
        const command = tokens.shift()?.toUpperCase()
        const isHeader = command === "HMSG"
        if (command !== "MSG" && !isHeader) return invalid("Unknown protocol command")
        const min = isHeader ? 4 : 3
        if (tokens.length !== min && tokens.length !== min + 1) return invalid("Invalid message control line")
        const subject = tokens[0] ?? ""
        subjectToken(subject)
        const sid = integer(tokens[1] ?? "")
        const reply = tokens.length === min + 1 ? tokens[2] : undefined
        if (reply !== undefined) subjectToken(reply)
        const size = integer(tokens.at(-1) ?? "")
        const headerSize = isHeader ? integer(tokens.at(-2) ?? "") : 0
        if (size > this.maxPayload || headerSize > size || (isHeader && headerSize !== 0 && headerSize < 12)) {
          return invalid("Message size exceeds protocol bounds")
        }
        this.pending = { subject, sid, size, headerSize, ...(reply === undefined ? {} : { reply }) }
      }
    }
    if (offset > 0) this.buffer.copyWithin(0, offset, this.used)
    this.used -= offset
    return frames
  }
}
