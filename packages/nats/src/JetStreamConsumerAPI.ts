/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Api from "./internal/jetstreamApi.ts"
import * as Wire from "./internal/jetstreamSchemas.ts"
import type * as JetStreamLister from "./JetStreamLister.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSError from "./NATSError.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamConsumerAPI")
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamConsumerAPI {
  readonly [TypeId]: TypeId
  readonly add: (
    stream: string,
    config: Partial<T.ConsumerConfig>,
    options?: T.ConsumerApiOptions
  ) => Effect.Effect<T.ConsumerInfo, NATSError.JetStreamConsumerAPIError>
  readonly update: (
    stream: string,
    name: string,
    config: Partial<T.ConsumerUpdateConfig>
  ) => Effect.Effect<T.ConsumerInfo, NATSError.JetStreamConsumerAPIError>
  readonly info: (stream: string, name: string) => Effect.Effect<T.ConsumerInfo, NATSError.JetStreamConsumerAPIError>
  readonly delete: (stream: string, name: string) => Effect.Effect<boolean, NATSError.JetStreamConsumerAPIError>
  readonly list: (stream: string) => Effect.Effect<
    JetStreamLister.JetStreamLister<T.ConsumerInfo, NATSError.JetStreamConsumerAPIError>,
    NATSError.JetStreamConsumerAPIError
  >
  readonly pause: (
    stream: string,
    name: string,
    until: Date | string
  ) => Effect.Effect<
    { readonly paused: boolean; readonly pause_until?: string; readonly pause_remaining: number },
    NATSError.JetStreamConsumerAPIError
  >
  readonly resume: (
    stream: string,
    name: string
  ) => Effect.Effect<
    { readonly paused: boolean; readonly pause_until?: string; readonly pause_remaining: number },
    NATSError.JetStreamConsumerAPIError
  >
  readonly unpin: (
    stream: string,
    name: string,
    group: string
  ) => Effect.Effect<void, NATSError.JetStreamConsumerAPIError>
  readonly reset: (
    stream: string,
    name: string,
    seq?: number
  ) => Effect.Effect<T.ConsumerResetResponse, NATSError.JetStreamConsumerAPIError>
  readonly leaderStepdown: (stream: string, name: string) => Effect.Effect<boolean, NATSError.JetStreamConsumerAPIError>
}

/** @internal */
export const make = (api: Api.JetStreamApi): JetStreamConsumerAPI => {
  const mapError = Api.mapError(NATSError.JetStreamConsumerAPIError)
  const info = Effect.fn("JetStreamConsumerAPI.info")(function*(stream: string, name: string) {
    yield* api.validateName("stream", stream)
    yield* api.validateName("consumer", name)
    return yield* api.api(`CONSUMER.INFO.${stream}.${name}`, {}, Wire.ConsumerInfo)
  }, mapError)
  const add = Effect.fn("JetStreamConsumerAPI.add")(function*(
    stream: string,
    config: Partial<T.ConsumerConfig>,
    options: T.ConsumerApiOptions = {},
    levelConfig: Partial<T.ConsumerConfig> = config
  ) {
    yield* api.validateName("stream", stream)
    if (config.deliver_group && (config.idle_heartbeat || config.flow_control)) {
      return yield* new NATSError.JetStreamConsumerAPIError({
        reason: "deliver_group and idle_heartbeat or flow_control are mutually exclusive"
      })
    }
    if (config.name) yield* api.requireVersion("Consumer name", [2, 9, 0])
    if (config.metadata || config.filter_subjects) {
      yield* api.requireVersion("Consumer metadata and multiple filters", [2, 10, 0])
    }
    if (
      config.pause_until || config.priority_groups?.length ||
      config.priority_policy && config.priority_policy !== "none"
    ) {
      yield* api.requireVersion("Consumer pause and priority groups", [2, 11, 0])
    }
    if (config.ack_policy === "flow_control") yield* api.requireVersion("Flow control ack policy", [2, 14, 0])
    if (config.priority_groups !== undefined) {
      yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String).check(Schema.isMinLength(1)))(
        config.priority_groups
      )
        .pipe(Effect.mapError((cause) =>
          new NATSError.JetStreamConsumerAPIError({
            reason: "'priority_groups' must be an array with at least one group",
            cause
          })
        ))
      yield* Schema.decodeUnknownEffect(Schema.Literals(["none", "prioritized", "overflow", "pinned_client"]))(
        config.priority_policy
      )
        .pipe(Effect.mapError((cause) =>
          new NATSError.JetStreamConsumerAPIError({
            reason: "'priority_policy' must be 'none', 'prioritized', 'overflow', or 'pinned_client'",
            cause
          })
        ))
    }
    const name = config.name || config.durable_name
    if (name) yield* api.validateName("consumer", name)
    const modern = yield* api.requireVersion("Consumer name", [2, 9, 0]).pipe(Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    }))
    const suffix = modern && name && !config.filter_subjects
      ? `CONSUMER.CREATE.${stream}.${name}${
        config.filter_subject && config.filter_subject !== ">"
          ? `.${config.filter_subject}`
          : ""
      }`
      : config.durable_name
      ? `CONSUMER.DURABLE.CREATE.${stream}.${config.durable_name}`
      : `CONSUMER.CREATE.${stream}`
    return yield* api.api(
      suffix,
      {
        stream_name: stream,
        config,
        action: options.action ?? "create",
        pedantic: options.pedantic ?? false
      },
      Wire.ConsumerInfo,
      levelConfig.ack_policy === "flow_control" ?
        4 :
        levelConfig.pause_until || levelConfig.priority_groups?.length ||
          levelConfig.priority_policy && levelConfig.priority_policy !== "none"
        ? 1
        : 0
    )
  }, mapError)
  const pause = Effect.fn("JetStreamConsumerAPI.pause")(function*(stream: string, name: string, until: Date | string) {
    yield* api.validateName("stream", stream)
    yield* api.validateName("consumer", name)
    yield* api.requireVersion("Consumer pause", [2, 11, 0])
    return yield* api.api(
      `CONSUMER.PAUSE.${stream}.${name}`,
      {
        pause_until: until instanceof Date ? until.toISOString() : until
      },
      Schema.Struct({
        paused: Schema.Boolean,
        pause_until: Schema.optionalKey(Schema.String),
        pause_remaining: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
      })
    )
  }, mapError)
  return {
    [TypeId]: TypeId,
    add,
    info,
    update: Effect.fn("JetStreamConsumerAPI.update")(function*(stream, name, config) {
      const current = yield* info(stream, name)
      return yield* add(stream, { ...current.config, ...config }, { action: "update" }, config)
    }),
    delete: (stream, name) =>
      api.validateName("stream", stream).pipe(
        Effect.andThen(api.validateName("consumer", name)),
        Effect.andThen(api.api(`CONSUMER.DELETE.${stream}.${name}`, {}, Wire.SuccessResponse)),
        Effect.map((response) => response.success),
        mapError
      ),
    list: (stream) =>
      api.validateName("stream", stream).pipe(
        Effect.as(api.list(`CONSUMER.LIST.${stream}`, {}, "consumers", Wire.ConsumerInfo)),
        Effect.map((lister) => ({
          ...lister,
          next: () => lister.next().pipe(mapError),
          stream: lister.stream.pipe(Api.mapStreamError(NATSError.JetStreamConsumerAPIError))
        })),
        mapError
      ),
    pause,
    resume: (stream, name) => pause(stream, name, "0001-01-01T00:00:00Z"),
    unpin: (stream, name, group) =>
      api.api(`CONSUMER.UNPIN.${stream}.${name}`, {
        group
      }, Schema.Struct({})).pipe(Effect.asVoid, mapError),
    reset: Effect.fnUntraced(function*(stream, name, seq) {
      if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) {
        return yield* new NATSError.JetStreamConsumerAPIError({ reason: "seq must be a non-negative integer" })
      }
      yield* api.requireVersion("Consumer reset", [2, 14, 0]).pipe(mapError)
      return yield* api.api(
        `CONSUMER.RESET.${stream}.${name}`,
        seq === undefined ? {} : { seq },
        Wire.ConsumerResetResponse
      ).pipe(mapError)
    }),
    leaderStepdown: (stream, name) =>
      api.api(`CONSUMER.LEADER.STEPDOWN.${stream}.${name}`, {}, Wire.SuccessResponse).pipe(
        Effect.map((response) => response.success),
        mapError
      )
  }
}
