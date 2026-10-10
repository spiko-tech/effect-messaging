/** @internal */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as JetStreamConsumer from "../JetStreamConsumer.ts"
import * as JetStreamConsumerAPI from "../JetStreamConsumerAPI.ts"
import * as JetStreamStoredMessage from "../JetStreamStoredMessage.ts"
import type * as JetStreamStream from "../JetStreamStream.ts"
import type * as JetStreamStreamAPI from "../JetStreamStreamAPI.ts"
import type * as T from "../JetStreamTypes.ts"
import * as NATSError from "../NATSError.ts"
import * as Api from "./jetstreamApi.ts"
import * as Wire from "./jetstreamSchemas.ts"

export const StreamAPITypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStreamAPI")
export const StreamTypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStream")
export const StreamsTypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStreams")

const minimumApiLevel = (config: Partial<T.StreamConfig>) =>
  config.allow_batched || config.mirror?.consumer ||
    config.sources?.some((source) => source.consumer) ?
    4 :
    config.allow_msg_counter || config.allow_atomic || config.allow_msg_schedules || config.persist_mode === "async" ?
    2 :
    config.allow_msg_ttl || (config.subject_delete_marker_ttl ?? 0) > 0
    ? 1
    : 0

/** @internal */
export const makeAPI = (api: Api.JetStreamApi): JetStreamStreamAPI.JetStreamStreamAPI => {
  const mapError = Api.mapError(NATSError.JetStreamStreamAPIError)
  const fixInfo = (info: T.StreamInfo): T.StreamInfo => {
    if (info.config.persist_mode !== "default") return info
    const { persist_mode: _persist_mode, ...config } = info.config
    return { ...info, config }
  }
  const normalizeSource = (source: T.StreamSource): T.StreamSource => {
    if (source.domain === undefined) return source
    const { domain, ...config } = source
    return { ...config, external: { ...source.external, api: `$JS.${domain}.API` } }
  }
  const normalize = (config: Partial<T.StreamConfig>): Partial<T.StreamConfig> => {
    const { persist_mode, ...rest } = config
    return {
      ...rest,
      ...(persist_mode !== undefined && persist_mode !== "default" ? { persist_mode } : {}),
      ...(config.mirror ? { mirror: normalizeSource(config.mirror) } : {}),
      ...(config.sources ? { sources: config.sources.map(normalizeSource) } : {})
    }
  }
  const validateFeatures = Effect.fnUntraced(function*(config: Partial<T.StreamConfig>) {
    if (
      config.metadata || config.first_seq || config.subject_transform || config.compression || config.consumer_limits ||
      config.mirror?.subject_transforms?.length || config.sources?.some((source) => source.subject_transforms?.length)
    ) {
      yield* api.requireVersion("Stream configuration", [2, 10, 0])
    }
    if (config.allow_msg_ttl || config.subject_delete_marker_ttl) {
      yield* api.requireVersion("Stream message TTL", [2, 11, 0])
    }
    if (config.allow_batched || config.mirror?.consumer || config.sources?.some((source) => source.consumer)) {
      yield* api.requireVersion("Stream batching and consumer sources", [2, 14, 0])
    }
    if (
      config.allow_atomic || config.allow_msg_counter || config.allow_msg_schedules || config.persist_mode === "async"
    ) {
      yield* api.requireVersion("Stream atomic publishing, counters, schedules and persist mode", [2, 12, 0])
    }
  })
  const info = Effect.fn("JetStreamStreamAPI.info")(function*(
    stream: string,
    options: Partial<T.StreamInfoRequestOptions> = {}
  ) {
    yield* api.validateName("stream", stream)
    const first = fixInfo(yield* api.api(`STREAM.INFO.${stream}`, options, Wire.StreamInfo))
    if (!options.subjects_filter || first.total <= first.limit || first.limit === 0) return first
    const subjects = yield* Stream.paginate(
      first.offset + first.limit,
      (offset) =>
        api.api(`STREAM.INFO.${stream}`, { ...options, offset }, Wire.StreamInfo).pipe(Effect.map((page) =>
          [
            [page.state.subjects ?? {}],
            page.limit > 0 && offset + page.limit < page.total
              ? Option.some(offset + page.limit)
              : Option.none<number>()
          ] as const
        ))
    ).pipe(Stream.runFold(() => ({ ...first.state.subjects }), (accumulated, page) => Object.assign(accumulated, page)))
    return { ...first, state: { ...first.state, subjects } }
  }, mapError)
  const names = (subject?: string) =>
    Effect.succeed(
      api.list("STREAM.NAMES", subject ? { subject } : {}, "streams", Schema.String)
    ).pipe(Effect.map((lister) => ({
      ...lister,
      next: () => lister.next().pipe(mapError),
      stream: lister.stream.pipe(Api.mapStreamError(NATSError.JetStreamStreamAPIError))
    })))
  return {
    [StreamAPITypeId]: StreamAPITypeId,
    info,
    get: Effect.fn("JetStreamStreamAPI.get")(function*(stream) {
      const value = yield* info(stream)
      return makeStream(api, value)
    }),
    add: Effect.fn("JetStreamStreamAPI.add")(function*(config) {
      yield* api.validateName("stream", config.name)
      yield* validateFeatures(config)
      return fixInfo(
        yield* api.api(`STREAM.CREATE.${config.name}`, normalize(config), Wire.StreamInfo, minimumApiLevel(config))
      )
    }, mapError),
    update: Effect.fn("JetStreamStreamAPI.update")(function*(stream, config) {
      yield* validateFeatures(config).pipe(mapError)
      const current = yield* info(stream)
      return yield* api.api(
        `STREAM.UPDATE.${stream}`,
        normalize({ ...current.config, ...config }),
        Wire.StreamInfo,
        minimumApiLevel(config)
      ).pipe(Effect.map(fixInfo), mapError)
    }),
    purge: Effect.fnUntraced(function*(stream, options = {}) {
      yield* api.validateName("stream", stream)
      if ("keep" in options && options.keep !== undefined && "seq" in options && options.seq !== undefined) {
        return yield* new NATSError.JetStreamStreamAPIError({ reason: "'keep','seq' are mutually exclusive" })
      }
      return yield* api.api(`STREAM.PURGE.${stream}`, options, Wire.PurgeResponse)
    }, mapError),
    delete: (stream) =>
      api.validateName("stream", stream).pipe(
        Effect.andThen(api.api(`STREAM.DELETE.${stream}`, {}, Wire.SuccessResponse)),
        Effect.map((response) => response.success),
        mapError
      ),
    list: (subject) =>
      Effect.succeed(api.list("STREAM.LIST", subject ? { subject } : {}, "streams", Wire.StreamInfo))
        .pipe(Effect.map((lister) => ({
          ...lister,
          next: () => lister.next().pipe(Effect.map((infos) => infos.map(fixInfo)), mapError),
          stream: lister.stream.pipe(Stream.map(fixInfo), Api.mapStreamError(NATSError.JetStreamStreamAPIError))
        }))),
    deleteMessage: (stream, seq, erase = true) =>
      api.validateName("stream", stream).pipe(
        Effect.andThen(api.api(`STREAM.MSG.DELETE.${stream}`, {
          seq,
          no_erase: !erase
        }, Wire.SuccessResponse)),
        Effect.map((response) => response.success),
        mapError
      ),
    getMessage: (stream, query) =>
      api.validateName("stream", stream).pipe(
        Effect.andThen(api.api(`STREAM.MSG.GET.${stream}`, query, Wire.StreamMsgResponse)),
        Effect.flatMap((response) => JetStreamStoredMessage.fromResponse(response.message)),
        Effect.map(Option.some),
        Effect.catchIf((error) => error instanceof Api.JetStreamApiError && error.apiError?.err_code === 10037, () =>
          Effect.succeed(Option.none())),
        mapError
      ),
    names,
    find: Effect.fn("JetStreamStreamAPI.find")(function*(subject) {
      const lister = yield* names(subject)
      const found = yield* lister.next()
      if (found.length !== 1) {
        return yield* new NATSError.JetStreamStreamAPIError({ reason: `Expected one stream for ${subject}` })
      }
      return found[0] ?? ""
    }),
    leaderStepdown: (stream, options = {}) =>
      api.api(`STREAM.LEADER.STEPDOWN.${stream}`, options, Wire.SuccessResponse).pipe(
        Effect.map((response) => response.success),
        mapError
      ),
    removePeer: (stream, peer) =>
      api.api(`STREAM.PEER.REMOVE.${stream}`, { peer }, Wire.SuccessResponse).pipe(
        Effect.map((response) => response.success),
        mapError
      )
  }
}

/** @internal */
export const makeStream = (api: Api.JetStreamApi, initial: T.StreamInfo): JetStreamStream.JetStreamStream => {
  const streamAPI = makeAPI(api)
  const mapError = Api.mapError(NATSError.JetStreamStreamError)
  const name = initial.config.name
  let cached = initial
  const info = (cache = false, options?: Partial<T.StreamInfoRequestOptions>) =>
    cache
      ? Effect.succeed(cached)
      : streamAPI.info(name, options).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            cached = value
          })
        ),
        mapError
      )
  return {
    [StreamTypeId]: StreamTypeId,
    name,
    info,
    getMessage: (query) => streamAPI.getMessage(name, query).pipe(mapError),
    deleteMessage: (seq, erase) => streamAPI.deleteMessage(name, seq, erase).pipe(mapError),
    alternates: info().pipe(Effect.map((value) => value.alternates ?? [])),
    best: info().pipe(Effect.flatMap((value) => {
      const alternate = value.alternates?.[0]
      return alternate && alternate.name !== name
        ? streamAPI.info(alternate.name).pipe(Effect.map((value) => makeStream(api, value)), mapError)
        : Effect.succeed(makeStream(api, value))
    })),
    resetConsumer: (consumer, seq) => JetStreamConsumerAPI.make(api).reset(name, consumer, seq).pipe(mapError),
    getPushConsumer: (stream, consumer) =>
      JetStreamConsumer.makeConsumers(api).getPushConsumer(stream, consumer).pipe(mapError),
    getConsumer: (consumer) => JetStreamConsumer.makeConsumers(api).get(name, consumer).pipe(mapError)
  }
}

/** @internal */
export const makeStreams = (api: Api.JetStreamApi): JetStreamStream.JetStreamStreams => ({
  [StreamsTypeId]: StreamsTypeId,
  get: (name) =>
    makeAPI(api).info(name).pipe(
      Effect.map((info) => makeStream(api, info)),
      Api.mapError(NATSError.JetStreamStreamError)
    )
})
