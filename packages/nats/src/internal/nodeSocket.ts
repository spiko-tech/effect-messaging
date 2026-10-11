/** @internal */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Latch from "effect/Latch"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import { Buffer } from "node:buffer"
import * as Net from "node:net"
import * as Tls from "node:tls"
import type * as NATSOptions from "../NATSOptions.ts"

/** @internal */
export const tlsUpgradeOptions = Effect.fnUntraced(function*(options: NATSOptions.NodeConnectionOptions) {
  const tls = options.tls
  if (tls === undefined || tls === false) return {}
  const fs = yield* FileSystem.FileSystem
  const key = tls.key ?? (tls.keyFile === undefined ? undefined : yield* fs.readFileString(tls.keyFile))
  const cert = tls.cert ?? (tls.certFile === undefined ? undefined : yield* fs.readFileString(tls.certFile))
  const ca = tls.ca ?? (tls.caFile === undefined ? undefined : yield* fs.readFileString(tls.caFile))
  return {
    ...(key === undefined ? {} : { key: Redacted.make(typeof key === "string" ? key : Buffer.from(key)) }),
    ...(cert === undefined ? {} : { cert: typeof cert === "string" ? cert : Buffer.from(cert) }),
    ...(ca === undefined ? {} : { ca: typeof ca === "string" ? ca : Buffer.from(ca) }),
    ...(tls.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tls.rejectUnauthorized })
  }
})
/** @since 0.1.0 */
export const makeSocket = Effect.fnUntraced(function*(
  endpoint: URL,
  options: NATSOptions.NodeConnectionOptions = {},
  tlsName?: string
) {
  if (endpoint.protocol !== "nats:" && endpoint.protocol !== "tls:") {
    return yield* Effect.fail(
      new Socket.SocketError({
        reason: new Socket.SocketOpenError({
          kind: "Unknown",
          cause: new Error("Node TCP transport requires a nats:// or tls:// endpoint; use the WebSocket transport")
        })
      })
    )
  }
  const tlsOptions = options.tls === false ? undefined : options.tls
  const host = endpoint.hostname.replace(/^\[|\]$/g, "")
  const servername = tlsOptions?.servername ??
    (Net.isIP(host) === 0 ? host : tlsName !== undefined && Net.isIP(tlsName) === 0 ? tlsName : undefined)
  const port = endpoint.port === "" ? 4222 : Number(endpoint.port)
  if (tlsOptions?.handshakeFirst) {
    const tls = yield* tlsUpgradeOptions(options).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.mapError((cause) =>
        new Socket.SocketError({
          reason: new Socket.SocketOpenError({
            kind: "Unknown",
            cause
          })
        })
      )
    )
    const connectionOptions: Tls.ConnectionOptions & Net.TcpSocketConnectOpts = {
      host,
      port,
      servername,
      ...(tls.key === undefined ? {} : { key: Redacted.value(tls.key) }),
      ...(tls.cert === undefined ? {} : { cert: tls.cert }),
      ...(tls.ca === undefined ? {} : { ca: tls.ca }),
      ...(tls.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tls.rejectUnauthorized }),
      autoSelectFamily: options.resolve !== false
    }
    return yield* NodeSocket.makeTls({ ...connectionOptions, openTimeout: options.timeout ?? 20_000 })
  }
  // NodeSocket's generic upgrade does not currently carry a TLS server name.
  // Keep its stream adapters, replacing the stream at the NATS INFO boundary.
  let raw: Net.Socket | undefined
  const open = Effect.acquireRelease(
    Effect.callback<Net.Socket, Socket.SocketError>((resume) => {
      const connection = Net.createConnection({
        host,
        port,
        // Node resolves all A/AAAA addresses and falls back between families.
        autoSelectFamily: options.resolve !== false
      })
      connection.setNoDelay(true)
      raw = connection
      const onOpen = () => resume(Effect.succeed(connection))
      const onError = (cause: Error) =>
        resume(Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
          })
        ))
      connection.once("connect", onOpen)
      connection.once("error", onError)
      return Effect.sync(() => {
        connection.removeListener("connect", onOpen)
        connection.removeListener("error", onError)
        if (connection.connecting) connection.destroy()
      })
    }),
    (connection) => Effect.sync(() => connection.destroy()),
    { interruptible: true }
  )
  const plain = yield* NodeSocket.fromDuplex(open, { openTimeout: options.timeout ?? 20_000 })
  const ready = yield* Latch.make(false)
  let currentWriter: Socket.Writer | undefined
  const reader = Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const plaintextReader = yield* plain.reader
    currentWriter = yield* plain.writer
    yield* ready.open
    const connection = raw
    if (connection === undefined) {
      return yield* Effect.fail(
        new Socket.SocketError({
          reason: new Socket.SocketOpenError({
            kind: "Unknown",
            cause: new Error("TCP connection missing")
          })
        })
      )
    }
    const listeners = connection.eventNames().map((event) => ({ event, handlers: connection.listeners(event) }))
    let currentReader = plaintextReader
    let upgraded = false
    const upgrade = Effect.fnUntraced(function*() {
      if (upgraded) {
        return yield* Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketUpgradeError({
              cause: new Error("Socket has already been upgraded")
            })
          })
        )
      }
      const tls = yield* tlsUpgradeOptions(options).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketUpgradeError({ cause }) }))
      )
      for (const { event, handlers } of listeners) {
        for (const handler of handlers) connection.removeListener(event, handler)
      }
      const secureOpen = Effect.acquireRelease(
        Effect.callback<Tls.TLSSocket, Socket.SocketError>((resume) => {
          let connected = false
          let secure: Tls.TLSSocket
          try {
            secure = Tls.connect({
              socket: connection,
              host,
              servername,
              ...(tls.key === undefined ? {} : { key: Redacted.value(tls.key) }),
              ...(tls.cert === undefined ? {} : { cert: tls.cert }),
              ...(tls.ca === undefined ? {} : { ca: tls.ca }),
              ...(tls.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tls.rejectUnauthorized })
            })
          } catch (cause) {
            resume(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketUpgradeError({ cause }) })))
            return Effect.void
          }
          const onOpen = () => {
            connected = true
            resume(Effect.succeed(secure))
          }
          const onError = (cause: Error) =>
            resume(Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketUpgradeError({ cause })
              })
            ))
          secure.once("secureConnect", onOpen)
          secure.once("error", onError)
          return Effect.sync(() => {
            secure.removeListener("secureConnect", onOpen)
            secure.removeListener("error", onError)
            if (!connected) secure.destroy()
          })
        }),
        (secure) => Effect.sync(() => secure.destroy()),
        { interruptible: true }
      )
      const secureSocket = yield* NodeSocket.fromDuplex(secureOpen, { openTimeout: options.timeout ?? 20_000 })
      currentReader = yield* secureSocket.reader
      currentWriter = yield* secureSocket.writer
      upgraded = true
    })
    return {
      pull: Effect.suspend(() => currentReader.pull),
      upgrade: () => upgrade().pipe(Effect.provideService(Scope.Scope, scope))
    }
  })
  return Socket.make({
    reader,
    writer: Effect.succeed({
      write: (chunk) =>
        ready.whenOpen(Effect.suspend(() =>
          currentWriter === undefined
            ? Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketWriteError({
                  cause: new Error("Writer is unavailable")
                })
              })
            )
            : currentWriter.write(chunk)
        )),
      writeAll: (chunks) =>
        ready.whenOpen(Effect.suspend(() =>
          currentWriter === undefined
            ? Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketWriteError({
                  cause: new Error("Writer is unavailable")
                })
              })
            )
            : currentWriter.writeAll(chunks)
        ))
    })
  })
})
