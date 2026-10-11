/** @internal */
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as JetStreamBatch from "../JetStreamBatch.ts"
import type * as JetStreamClient from "../JetStreamClient.ts"
import * as JetStreamConsumer from "../JetStreamConsumer.ts"
import * as JetStreamConsumerAPI from "../JetStreamConsumerAPI.ts"
import * as JetStreamDirectStreamAPI from "../JetStreamDirectStreamAPI.ts"
import * as JetStreamFastIngest from "../JetStreamFastIngest.ts"
import type * as JetStreamManager from "../JetStreamManager.ts"
import * as JetStreamStream from "../JetStreamStream.ts"
import * as JetStreamStreamAPI from "../JetStreamStreamAPI.ts"
import type * as T from "../JetStreamTypes.ts"
import type * as NATSConnection from "../NATSConnection.ts"
import * as NATSError from "../NATSError.ts"
import * as Api from "./jetstreamApi.ts"
import * as Publish from "./jetstreamPublish.ts"
import * as Wire from "./jetstreamSchemas.ts"

export const ClientTypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamClient")
export const ManagerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamManager")

/** @since 1.0.0 */
export const makeClient = (
  connection: NATSConnection.NATSConnection,
  options: T.JetStreamOptions = {}
): JetStreamClient.JetStreamClient => {
  const api = Api.make(connection, options)
  const mapError = Api.mapError(NATSError.JetStreamClientError)
  return {
    [ClientTypeId]: ClientTypeId,
    apiPrefix: api.prefix,
    publish: Effect.fn("JetStreamClient.publish")(function*(subject, payload, options = {}) {
      if (options.cancelSchedule?.scheduleSubject === subject) {
        return yield* new Api.JetStreamApiError({ reason: "Schedule cancellation cannot target the publish subject" })
      }
      const headers = yield* Publish.publishHeaders(options)
      const message = yield* connection.request(subject, payload, { timeout: options.timeout ?? api.timeout, headers })
        .pipe(Effect.retry({
          schedule: Schedule.recurs(Math.max(0, (options.retries ?? 1) - 1)).pipe(
            Schedule.addDelay(({ output }) =>
              Effect.succeed([0, 250, 250, 500, 500, 3000, 5000][Math.min(output, 6)] ?? 5000)
            )
          ),
          while: (error) => /responders|timeout|timed out/i.test(error.reason)
        }))
      return yield* api.decode(message.data, Wire.PubAck)
    }, mapError),
    startBatch: (subject, payload, options) => JetStreamBatch.make(api, subject, payload, options).pipe(mapError),
    startFastIngest: (subject, payload, options) =>
      JetStreamFastIngest.make(api, subject, payload, options).pipe(mapError),
    jetstreamManager: Effect.fn("JetStreamClient.jetstreamManager")(function*(checkAPI = options.checkAPI !== false) {
      const manager = makeManager(connection, { ...options, checkAPI })
      if (checkAPI) yield* manager.accountInfo.pipe(mapError)
      return manager
    }),
    options: api.configuration.pipe(mapError),
    consumers: JetStreamConsumer.makeConsumers(api),
    streams: JetStreamStream.makeJetStreamStreams(api)
  }
}
const Advisory = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown)
])
const AdvisoryKind = Schema.Literals([
  "api_audit",
  "stream_action",
  "consumer_action",
  "snapshot_create",
  "snapshot_complete",
  "restore_create",
  "restore_complete",
  "max_deliver",
  "terminated",
  "consumer_ack",
  "stream_leader_elected",
  "stream_quorum_lost",
  "consumer_leader_elected",
  "consumer_quorum_lost"
])
/** @since 1.0.0 */
export const makeManager = (
  connection: NATSConnection.NATSConnection,
  options: T.JetStreamManagerOptions = {}
): JetStreamManager.JetStreamManager => {
  const api = Api.make(connection, options)
  return {
    [ManagerTypeId]: ManagerTypeId,
    accountInfo: api.api("INFO", {}, Wire.JetStreamAccountStats).pipe(Api.mapError(NATSError.JetStreamManagerError)),
    advisoryStream: Stream.unwrap(Effect.gen(function*() {
      const subscription = yield* connection.subscribe("$JS.EVENT.ADVISORY.>")
      return subscription.stream.pipe(Stream.mapEffect(Effect.fnUntraced(function*(message) {
        const data = yield* message.decode(Advisory)
        const kind = yield* Schema.decodeUnknownEffect(AdvisoryKind)(data.type.split(".").at(-1))
        return { kind, data }
      })))
    })).pipe(Api.mapStreamError(NATSError.JetStreamManagerError)),
    options: api.configuration.pipe(Api.mapError(NATSError.JetStreamManagerError)),
    consumers: JetStreamConsumerAPI.make(api),
    streams: JetStreamStreamAPI.make(api),
    direct: JetStreamDirectStreamAPI.make(api),
    jetstream: Effect.sync(() => makeClient(connection, options))
  }
}
