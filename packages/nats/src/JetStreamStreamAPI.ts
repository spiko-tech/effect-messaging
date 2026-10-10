/**
 * @since 0.1.0
 */
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as internal from "./internal/jetstreamStreams.ts"
import type * as JetStreamLister from "./JetStreamLister.ts"
import type * as JetStreamStoredMessage from "./JetStreamStoredMessage.ts"
import type * as JetStreamStream from "./JetStreamStream.ts"
import type * as T from "./JetStreamTypes.ts"
import type * as NATSError from "./NATSError.ts"

/** @since 0.1.0 */
export const TypeId: typeof internal.StreamAPITypeId = internal.StreamAPITypeId
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamStreamAPI {
  readonly [TypeId]: TypeId
  readonly get: (stream: string) => Effect.Effect<JetStreamStream.JetStreamStream, NATSError.JetStreamStreamAPIError>
  readonly info: (
    stream: string,
    options?: Partial<T.StreamInfoRequestOptions>
  ) => Effect.Effect<T.StreamInfo, NATSError.JetStreamStreamAPIError>
  readonly add: (
    config: Partial<T.StreamConfig> & { readonly name: string }
  ) => Effect.Effect<T.StreamInfo, NATSError.JetStreamStreamAPIError>
  readonly update: (
    stream: string,
    config: Partial<T.StreamUpdateConfig>
  ) => Effect.Effect<T.StreamInfo, NATSError.JetStreamStreamAPIError>
  readonly purge: (
    stream: string,
    options?: Partial<T.PurgeOpts>
  ) => Effect.Effect<T.PurgeResponse, NATSError.JetStreamStreamAPIError>
  readonly delete: (stream: string) => Effect.Effect<boolean, NATSError.JetStreamStreamAPIError>
  readonly list: (subject?: string) => Effect.Effect<
    JetStreamLister.JetStreamLister<
      T.StreamInfo,
      NATSError.JetStreamStreamAPIError
    >
  >
  readonly deleteMessage: (
    stream: string,
    seq: number,
    erase?: boolean
  ) => Effect.Effect<boolean, NATSError.JetStreamStreamAPIError>
  readonly getMessage: (stream: string, query: T.MsgRequest) => Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamStreamAPIError
  >
  readonly find: (subject: string) => Effect.Effect<string, NATSError.JetStreamStreamAPIError>
  readonly names: (subject?: string) => Effect.Effect<
    JetStreamLister.JetStreamLister<
      string,
      NATSError.JetStreamStreamAPIError
    >
  >
  readonly leaderStepdown: (
    stream: string,
    options?: { readonly placement?: { readonly cluster: string } }
  ) => Effect.Effect<boolean, NATSError.JetStreamStreamAPIError>
  readonly removePeer: (stream: string, peer: string) => Effect.Effect<boolean, NATSError.JetStreamStreamAPIError>
}

/** @internal */
export const make = internal.makeAPI
