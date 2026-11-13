import { Effect, Redacted, Schedule, Schema } from "effect"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { connect as connectSocket, createServer } from "node:net"
import type * as Net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"

const execute = promisify(execFile)

// Only daemon creation and its ownership registration are masked. Readiness and lifecycle commands remain interruptible.
export const completeOwnedCreation = <A, E, R>(creation: Effect.Effect<A, E, R>, register: () => void) =>
  Effect.sync(register).pipe(Effect.andThen(creation), Effect.uninterruptible)

export class BrokerInfrastructureError extends Schema.TaggedError<BrokerInfrastructureError>()(
  "BrokerInfrastructureError",
  { operation: Schema.String, detail: Schema.String }
) {}

/** Drops actual broker bytes, not synthetic AMQP confirmations. @since 0.8.0 */
export const makeConfirmLossProxy = Effect.fn("makeConfirmLossProxy")(function*(brokerPort: number) {
  const sockets = new Set<Net.Socket>()
  let suppressBrokerBytes = false
  const server = createServer((client) => {
    const upstream = connectSocket({ host: "127.0.0.1", port: brokerPort })
    sockets.add(client)
    sockets.add(upstream)
    client.on("data", (bytes) => upstream.write(bytes))
    upstream.on("data", (bytes) => {
      if (!suppressBrokerBytes) client.write(bytes)
    })
    client.on("error", () => upstream.destroy())
    upstream.on("error", () => client.destroy())
    client.on("close", () => {
      sockets.delete(client)
      upstream.destroy()
    })
    upstream.on("close", () => {
      sockets.delete(upstream)
      client.destroy()
    })
  })
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => error ? reject(error) : resolve())
      })
    ).pipe(Effect.orDie)
  )
  yield* Effect.tryPromise(() =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
  )
  const address = server.address()
  if (address === null || typeof address === "string") return yield* Effect.die("TCP proxy has no mapped port")
  return {
    port: address.port,
    dropBrokerBytes: Effect.sync(() => {
      suppressBrokerBytes = true
    }),
    restoreBrokerBytes: Effect.sync(() => {
      suppressBrokerBytes = false
    })
  }
})

const NodeInfo = Schema.Struct({ name: Schema.String, mem_alarm: Schema.Boolean, disk_free_alarm: Schema.Boolean })
const QueueInfo = Schema.Struct({
  leader: Schema.optional(Schema.String),
  members: Schema.optional(Schema.Array(Schema.String))
})
const Port = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }))
const Json = Schema.fromJsonString(Schema.Unknown)
const Networks = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** @since 0.8.0 */
export const makeBrokerInfrastructure = Effect.fn("makeBrokerInfrastructure")(function*(size = 1) {
  const id = `effect-amqp-review-${randomUUID()}`
  const password = randomUUID()
  const containers: Array<string> = []
  const volumes: Array<string> = []
  let networkCreated = false
  const command = (program: string, args: Array<string>) =>
    Effect.tryPromise({
      try: (signal) => execute(program, args, { signal, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }),
      catch: (cause) =>
        new BrokerInfrastructureError({
          operation: `${program} ${args[0] ?? ""}`,
          detail: String(cause).replaceAll(password, "[REDACTED]")
        })
    }).pipe(Effect.map((result) => result.stdout.trim()))
  const docker = (...args: Array<string>) => command("docker", args)
  yield* docker("info", "--format", "{{.ServerVersion}}").pipe(
    Effect.mapError(() =>
      new BrokerInfrastructureError({
        operation: "Docker prerequisite",
        detail: "A running Docker daemon is required; qualification is never skipped"
      })
    )
  )
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), `${id}-`)),
      catch: (cause) => new BrokerInfrastructureError({ operation: "temporary directory", detail: String(cause) })
    }),
    (directory) =>
      Effect.gen(function*() {
        for (const container of containers) yield* docker("rm", "--force", container).pipe(Effect.ignore)
        for (const volume of volumes) yield* docker("volume", "rm", volume).pipe(Effect.ignore)
        if (networkCreated) yield* docker("network", "rm", id).pipe(Effect.ignore)
        yield* Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore)
      })
  )
  const file = (name: string) => join(directory, name)
  yield* Effect.tryPromise(() => chmod(directory, 0o755))
  const openssl = (...args: Array<string>) => command("openssl", args)
  yield* openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=effect-amqp-review-ca"
  )
  for (const name of ["server", "client"]) {
    yield* openssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      file(`${name}.key`),
      "-out",
      file(`${name}.csr`),
      "-subj",
      `/CN=${name === "server" ? "localhost" : "review-client"}`
    )
    yield* Effect.tryPromise(() =>
      writeFile(
        file(`${name}.ext`),
        name === "server"
          ? "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
          : "extendedKeyUsage=clientAuth\n"
      )
    )
    yield* openssl(
      "x509",
      "-req",
      "-in",
      file(`${name}.csr`),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-out",
      file(`${name}.pem`),
      "-days",
      "2",
      "-extfile",
      file(`${name}.ext`)
    )
  }
  yield* Effect.tryPromise(() => chmod(file("server.key"), 0o644))
  yield* Effect.tryPromise(() =>
    writeFile(
      file("rabbitmq.conf"),
      [
        "listeners.tcp.default = 5672",
        "listeners.ssl.default = 5671",
        "ssl_options.cacertfile = /etc/rabbitmq/review/ca.pem",
        "ssl_options.certfile = /etc/rabbitmq/review/server.pem",
        "ssl_options.keyfile = /etc/rabbitmq/review/server.key",
        "ssl_options.verify = verify_peer",
        "ssl_options.fail_if_no_peer_cert = true",
        "auth_mechanisms.1 = PLAIN",
        "auth_mechanisms.2 = AMQPLAIN",
        "auth_mechanisms.3 = EXTERNAL",
        "loopback_users.guest = true",
        "ssl_cert_login_from = common_name",
        "consumer_timeout = 60000",
        "cluster_partition_handling = pause_minority"
      ].join("\n")
    )
  )
  yield* Effect.tryPromise(() =>
    writeFile(file("enabled_plugins"), "[rabbitmq_management,rabbitmq_auth_mechanism_ssl].\n")
  )
  yield* completeOwnedCreation(docker("network", "create", "--label", `effect-amqp-review=${id}`, id), () => {
    networkCreated = true
  })
  const nodes: Array<{ name: string; hostname: string; port: number; tlsPort: number; managementPort: number }> = []
  const mappedPort = Effect.fnUntraced(function*(name: string, internal: number) {
    const text = yield* docker("port", name, `${internal}/tcp`)
    return yield* Schema.decodeUnknownEffect(Port)(text.split(":").at(-1))
  })
  const poll = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry(Schedule.spaced("1 second")),
      Effect.timeout("120 seconds")
    )
  for (let index = 0; index < size; index++) {
    const name = `${id}-${index}`
    const hostname = `node${index}`
    const volume = `${name}-data`
    yield* completeOwnedCreation(docker("volume", "create", "--label", `effect-amqp-review=${id}`, volume), () => {
      volumes.push(volume)
    })
    yield* completeOwnedCreation(
      docker(
        "create",
        "--name",
        name,
        "--hostname",
        hostname,
        "--label",
        `effect-amqp-review=${id}`,
        "--network",
        id,
        "--network-alias",
        hostname,
        "-p",
        "127.0.0.1::5672",
        "-p",
        "127.0.0.1::5671",
        "-p",
        "127.0.0.1::15672",
        "-v",
        `${volume}:/var/lib/rabbitmq`,
        "-e",
        `RABBITMQ_ERLANG_COOKIE=${id}`,
        "-e",
        "RABBITMQ_DEFAULT_USER=review",
        "-e",
        `RABBITMQ_DEFAULT_PASS=${password}`,
        "-e",
        "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 -kernel net_ticktime 5",
        "rabbitmq:4.3.6-management"
      ),
      () => {
        containers.push(name)
      }
    )
    yield* docker("cp", `${directory}/.`, `${name}:/etc/rabbitmq/review`)
    yield* docker("cp", file("rabbitmq.conf"), `${name}:/etc/rabbitmq/conf.d/90-review.conf`)
    yield* docker("cp", file("enabled_plugins"), `${name}:/etc/rabbitmq/enabled_plugins`)
    yield* docker("start", name)
    yield* poll(docker("exec", "--user", "rabbitmq", name, "rabbitmq-diagnostics", "-q", "check_running")).pipe(
      Effect.catch(() =>
        Effect.flatMap(docker("logs", name), (logs) =>
          Effect.fail(
            new BrokerInfrastructureError({
              operation: "RabbitMQ startup",
              detail: logs.replaceAll(password, "[REDACTED]")
            })
          ))
      )
    )
    nodes.push({
      name,
      hostname,
      port: yield* mappedPort(name, 5672),
      tlsPort: yield* mappedPort(name, 5671),
      managementPort: yield* mappedPort(name, 15672)
    })
    if (index > 0) {
      yield* docker("exec", "--user", "rabbitmq", name, "rabbitmqctl", "stop_app")
      yield* docker("exec", "--user", "rabbitmq", name, "rabbitmqctl", "reset")
      yield* docker("exec", "--user", "rabbitmq", name, "rabbitmqctl", "join_cluster", "rabbit@node0")
      yield* docker("exec", "--user", "rabbitmq", name, "rabbitmqctl", "start_app")
    }
  }
  const api = Effect.fn("broker.api")(function*(index: number, path: string, method = "GET", body?: unknown) {
    const boundaryError = () =>
      new BrokerInfrastructureError({ operation: "management API", detail: `${method} ${path}` })
    const encodedBody = body === undefined ? undefined : yield* Schema.encodeEffect(Json)(body)
      .pipe(Effect.mapError(boundaryError))
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`http://127.0.0.1:${nodes[index].managementPort}/api/${path}`, {
          method,
          headers: {
            authorization: `Basic ${Buffer.from(`review:${password}`).toString("base64")}`,
            "content-type": "application/json"
          },
          ...(encodedBody === undefined ? {} : { body: encodedBody }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
        }),
      catch: () => new BrokerInfrastructureError({ operation: "management API", detail: path })
    })
    if (!response.ok) {
      return yield* new BrokerInfrastructureError({
        operation: "management API",
        detail: `${method} ${path}: ${response.status}`
      })
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") return undefined
    const text = yield* Effect.tryPromise({ try: () => response.text(), catch: boundaryError })
    return yield* Schema.decodeEffect(Json)(text).pipe(Effect.mapError(boundaryError))
  })
  yield* poll(api(0, "overview"))
  const ctl = (index: number, ...args: Array<string>) =>
    docker("exec", "--user", "rabbitmq", nodes[index].name, "rabbitmqctl", ...args)
  yield* ctl(0, "add_user", "review-client", password)
  yield* ctl(0, "set_permissions", "-p", "/", "review-client", ".*", ".*", ".*")
  const tls = {
    ca: yield* Effect.tryPromise(() => readFile(file("ca.pem"))),
    cert: yield* Effect.tryPromise(() => readFile(file("client.pem"))),
    key: yield* Effect.tryPromise(() => readFile(file("client.key"))),
    servername: "localhost",
    rejectUnauthorized: true
  }
  const connect = (index = 0, overrides: Partial<AMQPNodeConnection.ConnectionOptions> = {}) =>
    AMQPNodeConnection.make({
      hostname: "127.0.0.1",
      port: nodes[index].port,
      username: "review",
      password: Redacted.make(password),
      heartbeat: 2,
      connectionTimeout: "10 seconds",
      ...overrides
    })
  const queueInfo = (index: number, queue: string) =>
    api(index, `queues/%2F/${encodeURIComponent(queue)}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(QueueInfo))
    )
  const alarms = (index = 0) =>
    api(index, "nodes").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(NodeInfo))))
  const logs = (index = 0) =>
    docker("logs", nodes[index].name).pipe(
      Effect.map((text) => text.replaceAll(password, "[REDACTED]"))
    )
  const stop = (index = 0) => docker("stop", "--time", "30", nodes[index].name)
  const start = Effect.fn("broker.start")(function*(index = 0) {
    yield* docker("start", nodes[index].name)
    yield* poll(docker("exec", "--user", "rabbitmq", nodes[index].name, "rabbitmq-diagnostics", "-q", "check_running"))
    nodes[index].port = yield* mappedPort(nodes[index].name, 5672)
    nodes[index].tlsPort = yield* mappedPort(nodes[index].name, 5671)
    nodes[index].managementPort = yield* mappedPort(nodes[index].name, 15672)
    yield* poll(api(index, "overview"))
  })
  const isolate = Effect.fn("broker.isolate")(function*(index: number) {
    yield* docker("network", "disconnect", id, nodes[index].name)
    const networks = yield* docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", nodes[index].name)
      .pipe(
        Effect.flatMap(Schema.decodeEffect(Networks)),
        Effect.mapError(() =>
          new BrokerInfrastructureError({
            operation: "network isolation",
            detail: "Invalid Docker network attachment data"
          })
        )
      )
    if (Object.keys(networks).length !== 0) {
      return yield* new BrokerInfrastructureError({
        operation: "network isolation",
        detail: "Owned container still has a network attachment"
      })
    }
  })
  const heal = Effect.fn("broker.heal")(function*(index: number) {
    yield* docker("network", "connect", "--alias", nodes[index].hostname, id, nodes[index].name)
    nodes[index].port = yield* mappedPort(nodes[index].name, 5672)
    nodes[index].tlsPort = yield* mappedPort(nodes[index].name, 5671)
    nodes[index].managementPort = yield* mappedPort(nodes[index].name, 15672)
  })
  return { id, nodes, connect, ctl, api, queueInfo, alarms, logs, poll, stop, start, isolate, heal, tls }
})
