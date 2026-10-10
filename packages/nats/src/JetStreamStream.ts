/**
 * @since 0.1.0
 */
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as internal from "./internal/jetstreamStreams.ts"
import type * as JetStreamConsumer from "./JetStreamConsumer.ts"
import type * as JetStreamStoredMessage from "./JetStreamStoredMessage.ts"
import type * as T from "./JetStreamTypes.ts"
import type * as NATSError from "./NATSError.ts"

/** @since 0.1.0 */
export const JetStreamStreamTypeId: typeof internal.StreamTypeId = internal.StreamTypeId
/** @since 0.1.0 */
export type JetStreamStreamTypeId = typeof JetStreamStreamTypeId
/** @since 0.1.0 */
export interface JetStreamStream {
  readonly [JetStreamStreamTypeId]: JetStreamStreamTypeId
  readonly name: string
  readonly info: (
    cached?: boolean,
    options?: Partial<T.StreamInfoRequestOptions>
  ) => Effect.Effect<T.StreamInfo, NATSError.JetStreamStreamError>
  readonly getMessage: (query: T.MsgRequest) => Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamStreamError
  >
  readonly deleteMessage: (seq: number, erase?: boolean) => Effect.Effect<boolean, NATSError.JetStreamStreamError>
  readonly alternates: Effect.Effect<Array<T.StreamAlternate>, NATSError.JetStreamStreamError>
  readonly best: Effect.Effect<JetStreamStream, NATSError.JetStreamStreamError>
  readonly resetConsumer: (consumer: string, seq?: number) => Effect.Effect<
    T.ConsumerResetResponse,
    NATSError.JetStreamStreamError
  >
  readonly getPushConsumer: (
    stream: string,
    name?: string | Partial<T.OrderedPushConsumerOptions>
  ) => Effect.Effect<JetStreamConsumer.PushConsumer, NATSError.JetStreamStreamError>
  readonly getConsumer: (
    name?: string | Partial<T.OrderedConsumerOptions>
  ) => Effect.Effect<JetStreamConsumer.Consumer, NATSError.JetStreamStreamError>
}
/** @internal */
export const makeJetStreamStream = internal.makeStream
/** @since 0.1.0 */
export const JetStreamStreamsTypeId: typeof internal.StreamsTypeId = internal.StreamsTypeId
/** @since 0.1.0 */
export type JetStreamStreamsTypeId = typeof JetStreamStreamsTypeId
/** @since 0.1.0 */
export interface JetStreamStreams {
  readonly [JetStreamStreamsTypeId]: JetStreamStreamsTypeId
  readonly get: (name: string) => Effect.Effect<JetStreamStream, NATSError.JetStreamStreamError>
}
/** @internal */
export const makeJetStreamStreams = internal.makeStreams
