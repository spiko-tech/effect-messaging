import { Effect, Schedule } from "effect"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const image = "nats:2.15.0-alpine"
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address()
      if (address === null || typeof address === "string") {
        reservation.close()
        reject(new Error("Cannot reserve fixture port"))
        return
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port))
    })
  })

const waitForPort = (port: number) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port })
        socket.once("connect", () => {
          socket.destroy()
          resolve()
        })
        socket.once("error", reject)
      }),
    catch: (cause) => new Error("Broker's published port is not ready", { cause })
  }).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }))

/** Isolated, scoped broker fixtures fail explicitly when Docker is unavailable. */
export interface TestServer {
  readonly name: string
  readonly url: string
  readonly websocketUrl: string
  readonly directory: string
  readonly stop: Effect.Effect<void, Error>
  readonly start: Effect.Effect<void, Error>
  readonly reload: (config: string) => Effect.Effect<void, Error>
}

const waitForReady = (name: string, since?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const logs = spawn("docker", ["logs", "--follow", ...(since === undefined ? [] : ["--since", since]), name], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    let finished = false
    const timer = setTimeout(() => finish(new Error(`Broker ${name} did not become ready: ${output}`)), 20_000)
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      logs.kill()
      if (error === undefined) resolve()
      else reject(error)
    }
    const onData = (data: Buffer) => {
      output += data.toString()
      if (output.includes("Server is ready")) finish()
    }
    logs.stdout.on("data", onData)
    logs.stderr.on("data", onData)
    logs.on("error", finish)
    logs.on("exit", (code) => {
      if (!output.includes("Server is ready")) finish(new Error(`Broker exited before readiness (${code}): ${output}`))
    })
  })

const command = (...args: Array<string>) =>
  Effect.tryPromise({
    try: () => execute("docker", args),
    catch: (cause) => new Error(`docker ${args[0]} failed`, { cause })
  })

/** Configuration is written before startup; cleanup runs on failed acquisition and scope closure. */
export const makeServer = (options?: {
  readonly config?: string
  readonly name?: string
  readonly network?: string
  readonly jetstream?: boolean
  readonly prepare?: (directory: string) => Promise<void>
}) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<TestServer> => {
        const name = options?.name ?? `effect-nats-test-${randomUUID()}`
        const directory = await mkdtemp(join(tmpdir(), "effect-nats-test-"))
        try {
          await options?.prepare?.(directory)
          await writeFile(
            join(directory, "server.conf"),
            [
              "port: 4222",
              ...(options?.jetstream === false ? [] : ["jetstream { store_dir: /tmp/jetstream }"]),
              options?.config ?? ""
            ].join("\n")
          )
          // Docker may run on another host, whose allocated ports cannot be reserved by this process.
          // Retry only concrete bind collisions, preserving the chosen mapping across broker restarts.
          for (let attempt = 0; attempt < 10; attempt++) {
            const tcpHostPort = await freePort()
            const websocketHostPort = await freePort()
            try {
              await execute("docker", [
                "create",
                "--name",
                name,
                ...(options?.network === undefined ? [] : ["--network", options.network]),
                "--publish",
                `127.0.0.1:${tcpHostPort}:4222`,
                "--publish",
                `127.0.0.1:${websocketHostPort}:8080`,
                image,
                "--config",
                "/fixture/server.conf"
              ])
              await execute("docker", ["cp", directory, `${name}:/fixture`])
              await execute("docker", ["start", name])
              break
            } catch (cause) {
              if (!(cause instanceof Error) || !cause.message.includes("address already in use") || attempt === 9) {
                throw cause
              }
              await execute("docker", ["rm", "--force", name])
            }
          }
          await waitForReady(name)
          const port = async (containerPort: string) => {
            const result = await execute("docker", ["port", name, containerPort])
            return result.stdout.trim().split(":").at(-1)
          }
          const tcpPort = await port("4222/tcp")
          const websocketPort = await port("8080/tcp")
          await Effect.runPromise(waitForPort(Number(tcpPort)))
          if (options?.config?.includes("websocket") || options?.config?.includes("http: 8080")) {
            await Effect.runPromise(waitForPort(Number(websocketPort)))
          }
          return {
            name,
            directory,
            url: `nats://127.0.0.1:${tcpPort}`,
            websocketUrl: `ws://127.0.0.1:${websocketPort}`,
            stop: command("stop", "--time", "1", name).pipe(Effect.asVoid),
            reload: (config) =>
              Effect.tryPromise({
                try: async () => {
                  await writeFile(
                    join(directory, "server.conf"),
                    [
                      "port: 4222",
                      ...(options?.jetstream === false ? [] : ["jetstream { store_dir: /tmp/jetstream }"]),
                      config
                    ].join("\n")
                  )
                  await execute("docker", ["cp", join(directory, "server.conf"), `${name}:/fixture/server.conf`])
                  await execute("docker", ["kill", "--signal", "HUP", name])
                },
                catch: (cause) => new Error("Broker reload failed", { cause })
              }),
            start: Effect.tryPromise({
              try: async () => {
                const since = new Date().toISOString()
                await execute("docker", ["start", name])
                await waitForReady(name, since)
                await Effect.runPromise(waitForPort(Number(tcpPort)))
              },
              catch: (cause) => new Error("Broker restart failed", { cause })
            })
          }
        } catch (cause) {
          await execute("docker", ["rm", "--force", name]).catch(() => undefined)
          await rm(directory, { recursive: true, force: true })
          throw cause
        }
      },
      catch: (cause) => new Error("Cannot start isolated NATS integration fixture", { cause })
    }),
    (server) =>
      Effect.promise(async () => {
        await execute("docker", ["rm", "--force", server.name])
        await rm(server.directory, { recursive: true, force: true })
      })
  )

/** Locally generated CA/server material avoids expired checked-in certificate fixtures. */
export const prepareTLS = async (directory: string): Promise<void> => {
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(directory, "server.key"),
    "-out",
    join(directory, "server.crt"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ])
}
