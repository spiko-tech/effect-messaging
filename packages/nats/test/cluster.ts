import { Effect, Schedule, Schema } from "effect"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { makeServer } from "./server.ts"

const execute = promisify(execFile)
const RouteInfo = Schema.Struct({ num_routes: Schema.Number })
const network = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const name = `effect-nats-cluster-${randomUUID()}`
      await execute("docker", ["network", "create", name])
      return name
    },
    catch: (cause) => new Error("Cannot create isolated cluster network", { cause })
  }),
  (name) =>
    Effect.promise(async () => {
      await execute("docker", ["network", "rm", name])
    })
)

/** Scoped three-node JetStream cluster; route convergence is checked through monitoring responses. */
export const makeCluster = Effect.gen(function*() {
  const clusterNetwork = yield* network
  const names = [0, 1, 2].map((index) => `${clusterNetwork}-${index}`)
  const servers = yield* Effect.forEach(names, (name) =>
    makeServer({
      name,
      network: clusterNetwork,
      config: [
        `server_name: "${name}"`,
        `server_tags: ["parity-node-${names.indexOf(name)}"]`,
        "http: 8080",
        "cluster {",
        "name: \"effect-native-parity\", listen: \"0.0.0.0:6222\",",
        `routes: [${names.filter((peer) => peer !== name).map((peer) => `"nats://${peer}:6222"`).join(",")}]`,
        "}"
      ].join("\n")
    }), { concurrency: "unbounded" })
  yield* Effect.forEach(servers, (server) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(server.websocketUrl.replace("ws:", "http:") + "/routez")
        return await response.json()
      },
      catch: (cause) => new Error("Cluster monitoring is not ready", { cause })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RouteInfo)),
      Effect.flatMap((info) =>
        info.num_routes >= 2 ? Effect.void : Effect.fail(new Error("Cluster routes have not converged"))
      ),
      Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 400 })
    ), { concurrency: "unbounded" })
  return servers
})
