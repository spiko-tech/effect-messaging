/**
 * @since 1.0.0
 */
/*
 * Copyright 2023-2026 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License")

 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** @since 1.0.0 */

import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as JetStreamMessage from "./JetStreamMessage.ts"
import type * as JetStreamStoredMessage from "./JetStreamStoredMessage.ts"
import type * as NATSHeaders from "./NATSHeaders.ts"

/** @since 1.0.0 */
export type ApiPaged = {
  total: number

  offset: number

  limit: number
}

/** @since 1.0.0 */
export type ApiPagedRequest = {
  offset: number
}

/** @since 1.0.0 */
export type ApiResponse = {
  type: string

  error?: ApiError
}

/** @since 1.0.0 */
export type ApiError = {
  /**
   * HTTP like error code in the 300 to 500 range
   */
  code: number

  /**
   * A human friendly description of the error
   */
  description: string

  /**
   * The NATS error code unique to each kind of error
   */
  err_code: number
}

/**
 * An alternate location to read mirrored data
 * @since 1.0.0
 */
export type StreamAlternate = {
  /**
   * The mirror Stream name
   */
  name: string

  /**
   * The name of the cluster holding the Stream
   */
  cluster: string

  /**
   * The domain holding the Stream
   */
  domain: string
}

/**
 * Stream configuration info
 * @since 1.0.0
 */
export type StreamInfo = ApiPaged & {
  /**
   * The active configuration for the Stream
   */
  config: StreamConfig

  /**
   * The ISO Timestamp when the stream was created
   */
  created: string

  /**
   * Detail about the current State of the Stream
   */
  state: StreamState

  /**
   * Cluster information for the stream if applicable
   */
  cluster?: ClusterInfo

  /**
   * Information about an upstream stream source in a mirror
   */
  mirror?: StreamSourceInfo

  /**
   * Sources for the Stream if applicable
   */
  sources?: Array<StreamSourceInfo>

  /**
   * Alternates for a stream if applicable. Alternates are listed
   * in order of TTL. With streams at the start of the Array potentially
   * closer and faster to access.
   */
  alternates?: Array<StreamAlternate>

  /**
   * The ISO timestamp when the StreamInfo was generated. This field is only available
   * on servers 2.10.x or better
   */
  "ts"?: string
}

/** @since 1.0.0 */
export type SubjectTransformConfig = {
  /**
   * The source pattern
   */
  src?: string

  /**
   * The destination pattern
   */
  dest: string
}

/**
 * Sets default consumer limits for inactive_threshold and max_ack_pending
 * to consumers of this stream that don't specify specific values.
 * This functionality requires a server 2.10.x or better.
 * @since 1.0.0
 */
export type StreamConsumerLimits = {
  /**
   * The default `inactive_threshold` applied to consumers.
   * This value is specified in nanoseconds. Please use the `nanos()`
   * function to convert between millis and nanoseconds. Or `millis()`
   * to convert a nanosecond value to millis.
   */
  "inactive_threshold"?: Nanos

  /**
   * The default `max_ack_pending` applied to consumers of the stream.
   */
  "max_ack_pending"?: number
}

/** @since 1.0.0 */
export type StreamConfig = StreamUpdateConfig & {
  /**
   * A unique name for the Stream
   */
  name: string

  /**
   * How messages are retained in the Stream, once this is exceeded old messages are removed.
   */
  retention: RetentionPolicy

  /**
   * The storage backend to use for the Stream.
   */
  storage: StorageType

  /**
   * How many Consumers can be defined for a given Stream. -1 for unlimited.
   */
  "max_consumers": number

  /**
   * Sealed streams do not allow messages to be deleted via limits or API,
   * sealed streams can not be unsealed via configuration update.
   * Can only be set on already created streams via the Update API
   */
  sealed: boolean

  /**
   * Sets the first sequence number used by the stream. This property can only be
   * specified when creating the stream, and likely is not valid on mirrors etc.,
   * as it may disrupt the synchronization logic.
   */
  "first_seq": number

  /**
   * Enables a NATS stream implementation of CRDT operations.
   * Cannot be changed once the stream is created.
   */
  "allow_msg_counter": boolean

  /**
   * Sets the persistence model for the stream - the default is PersistMode.Default.
   * This is a 2.12 feature. Cannot be changed once the stream is created.
   */
  "persist_mode"?: PersistMode
}

/**
 * Stream options that can be updated
 * @since 1.0.0
 */
export type StreamUpdateConfig = {
  /** Seals a stream permanently. @since 0.1.0 */
  sealed?: boolean
  /**
   * A list of subjects to consume, supports wildcards. Must be empty when a mirror is configured. May be empty when sources are configured.
   */
  subjects: Array<string>

  /**
   * A short description of the purpose of this stream
   */
  description?: string

  /**
   * For wildcard streams ensure that for every unique subject this many messages are kept - a per subject retention limit
   */
  "max_msgs_per_subject": number

  /**
   * How many messages may be in a Stream, oldest messages will be removed if the Stream exceeds this size. -1 for unlimited.
   */
  "max_msgs": number

  /**
   * Maximum age of any message in the stream, expressed in nanoseconds. 0 for unlimited.
   */
  "max_age": Nanos

  /**
   * How big the Stream may be, when the combined stream size exceeds this old messages are removed. -1 for unlimited.
   */
  "max_bytes": number

  /**
   * The largest message that will be accepted by the Stream. -1 for unlimited.
   */
  "max_msg_size": number

  /**
   * When a Stream reach its limits either old messages are deleted or new ones are denied
   */
  discard: DiscardPolicy

  /**
   * Sets the context of the on a per subject basis. Requires {@link DiscardPolicy#New} as the
   * {@link discard} policy.
   */
  discard_new_per_subject: boolean

  /**
   * Disables acknowledging messages that are received by the Stream.
   */
  "no_ack"?: boolean

  /**
   * The time window to track duplicate messages for, expressed in nanoseconds. 0 for default
   * Set {@link JetStreamPublishOptions#msgID} to enable duplicate detection.
   */
  "duplicate_window": Nanos

  /**
   * List of Stream names to replicate into this Stream
   */
  sources?: Array<StreamSource>

  /**
   * Allows the use of the {@link JsHeaders#RollupHdr} header to replace all contents of a stream,
   * or subject in a stream, with a single new message
   */
  "allow_rollup_hdrs": boolean

  /**
   * How many replicas to keep for each message. Min 1, Max 5. Default 1.
   */
  "num_replicas": number

  /**
   * Placement directives to consider when placing replicas of this stream, random placement when unset
   */
  placement?: Placement

  /**
   * Restricts the ability to delete messages from a stream via the API.
   * Cannot be changed once set to true
   */
  "deny_delete": boolean

  /**
   * Restricts the ability to purge messages from a stream via the API.
   * Cannot be change once set to true
   */
  "deny_purge": boolean

  /**
   * Allow higher performance, direct access to get individual messages via the $JS.DS.GET API
   */
  "allow_direct": boolean

  /**
   * Allow higher performance, direct access to get individual messages via the $JS.DS.GET API
   */
  "mirror_direct": boolean

  /**
   * Rules for republishing messages from a stream with subject mapping
   * onto new subjects for partitioning and more
   */
  republish?: Republish

  /**
   * Metadata field to store additional information about the stream. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>

  /**
   * Apply a subject transform to incoming messages before doing anything else.
   * This feature only supported on 2.10.x and better.
   */
  "subject_transform"?: SubjectTransformConfig

  /**
   * Sets the compression level of the stream. This feature is only supported in
   * servers 2.10.x and better.
   */
  compression?: StoreCompression

  /**
   * The consumer limits applied to consumers that don't specify limits
   * for `inactive_threshold` or `max_ack_pending`. Note that these limits
   * become an upper bound for all clients.
   */
  "consumer_limits"?: StreamConsumerLimits

  /**
   * Sets a duration for adding server markers for delete, purge and max age limits.
   */
  "subject_delete_marker_ttl"?: Nanos

  /**
   * Maintains a 1:1 mirror of another stream with name matching this property.
   * When a mirror is configured subjects and sources must be empty.
   */
  mirror?: StreamSource | undefined
  // same as a source

  /**
   * Enables allows header initiated per-message TTLs. If disabled, then the `NATS-TTL`
   * header will be ignored.
   */
  "allow_msg_ttl"?: boolean

  /**
   * Enables the scheduling of messages in a stream.
   */
  "allow_msg_schedules"?: boolean

  /**
   * Enables the ability to send atomic batches to the stream.
   */
  "allow_atomic"?: boolean

  /**
   * Enables the ability to send batched messages to the stream.
   */
  "allow_batched"?: boolean
}

/** @since 1.0.0 */
export type Republish = {
  /**
   * The source subject to republish
   */
  src: string

  /**
   * The destination to publish to
   */
  dest: string

  /**
   * Only send message headers, no bodies
   */
  "headers_only"?: boolean
}

/** @since 1.0.0 */
export type ExternalStream = {
  /**
   * API prefix for the remote stream - the API prefix should be something like
   * `$JS.domain.API where domain is the JetStream domain on the NATS server configuration.
   */
  api: string

  /**
   * Deliver prefix for the remote stream
   */
  deliver?: string
}

/** @since 1.0.0 */
export type StreamSource = {
  /**
   * Name of the stream source
   */
  name: string

  /**
   * An optional start sequence from which to start reading messages
   */
  "opt_start_seq"?: number

  /**
   * An optional start time Date string
   */
  "opt_start_time"?: string

  /**
   * An optional filter subject. If the filter matches the message will be
   * on-boarded.
   */
  "filter_subject"?: string

  /**
   * This value cannot be set if domain is set
   */
  external?: ExternalStream

  /**
   * This field is a convenience for setting up an ExternalStream.
   * If set, the value here is used to calculate the JetStreamAPI prefix.
   * This field is never serialized to the server. This value cannot be set
   * if external is set.
   */
  domain?: string

  /**
   * Apply a subject transforms to sourced messages before doing anything else.
   * This feature only supported on 2.10.x and better.
   */
  subject_transforms?: Array<SubjectTransformConfig>

  /**
   * Configures durable sourcing using a pre-created consumer. When set, the
   * server uses the named durable consumer instead of an ephemeral ordered
   * consumer. Required for reliable mirroring/sourcing of WorkQueue or
   * Interest streams. Available on server 2.14+ (ADR-60).
   */
  consumer?: StreamConsumerSource
}

/**
 * Identifies a pre-created durable consumer used for stream
 * sourcing/mirroring. The referenced consumer must exist before the stream
 * is created and must use `ack_policy: "flow_control"` — any other policy
 * (`none`, `explicit`, `all`) is rejected by the server. See ADR-60.
 * @since 1.0.0
 */
export type StreamConsumerSource = {
  /**
   * Name of the pre-created consumer to use.
   */
  name: string

  /**
   * Subject the server delivers messages to. Must match the
   * `deliver_subject` of the pre-created consumer.
   */
  deliver_subject: string
}

/** @since 1.0.0 */
export type Placement = {
  /**
   * The cluster to place the stream on
   */
  cluster: string

  /**
   * Tags matching server configuration
   */
  tags: Array<string>
}

/** @since 1.0.0 */
export const RetentionPolicy = {
  /**
   * Retain messages until the limits are reached, then trigger the discard policy.
   */
  Limits: "limits",
  /**
   * Retain messages while there is consumer interest on the particular subject.
   */
  Interest: "interest",
  /**
   * Retain messages until acknowledged
   */
  Workqueue: "workqueue"
} as const

/** @since 1.0.0 */
export type RetentionPolicy = typeof RetentionPolicy[keyof typeof RetentionPolicy]

/** @since 1.0.0 */
export const DiscardPolicy = {
  /**
   * Discard old messages to make room for the new ones
   */
  Old: "old",
  /**
   * Discard the new messages
   */
  New: "new"
} as const

/** @since 1.0.0 */
export type DiscardPolicy = typeof DiscardPolicy[keyof typeof DiscardPolicy]

/** @since 1.0.0 */
export const StorageType = {
  /**
   * Store persistently on files
   */
  File: "file",
  /**
   * Store in server memory - doesn't survive server restarts
   */
  Memory: "memory"
} as const

/** @since 1.0.0 */
export type StorageType = typeof StorageType[keyof typeof StorageType]

/** @since 1.0.0 */
export const DeliverPolicy = {
  /**
   * Deliver all messages
   */
  All: "all",
  /**
   * Deliver starting with the last message
   */
  Last: "last",
  /**
   * Deliver starting with new messages
   */
  New: "new",
  /**
   * Deliver starting with the specified sequence
   */
  StartSequence: "by_start_sequence",
  /**
   * Deliver starting with the specified time
   */
  StartTime: "by_start_time",
  /**
   * Deliver starting with the last messages for every subject
   */
  LastPerSubject: "last_per_subject"
} as const

/** @since 1.0.0 */
export type DeliverPolicy = typeof DeliverPolicy[keyof typeof DeliverPolicy]

/** @since 1.0.0 */
export const AckPolicy = {
  /**
   * Messages don't need to be Ack'ed.
   */
  None: "none",
  /**
   * Ack, acknowledges all messages with a lower sequence
   */
  All: "all",
  /**
   * All sequences must be explicitly acknowledged
   */
  Explicit: "explicit",
  /**
   * Functions like AckAll, but acks based on flow control responses. Used
   * for durable mirror/source consumers (ADR-60). Available on server 2.14+.
   */
  FlowControl: "flow_control",
  /**
   * @ignore
   */
  NotSet: ""
} as const

/** @since 1.0.0 */
export type AckPolicy = typeof AckPolicy[keyof typeof AckPolicy]

/** @since 1.0.0 */
export const ReplayPolicy = {
  /**
   * Replays messages as fast as possible
   */
  Instant: "instant",
  /**
   * Replays messages following the original delay between messages
   */
  Original: "original"
} as const

/** @since 1.0.0 */
export type ReplayPolicy = typeof ReplayPolicy[keyof typeof ReplayPolicy]

/** @since 1.0.0 */
export const StoreCompression = {
  /**
   * No compression
   */
  None: "none",
  /**
   * S2 compression
   */
  S2: "s2"
} as const

/** @since 1.0.0 */
export type StoreCompression = typeof StoreCompression[keyof typeof StoreCompression]

/** @since 1.0.0 */
export const PersistMode = {
  /**
   * All writes are committed and stream data is synced to disk before the publish
   * acknowledgement is sent.
   * This is the default mode, and provides the strongest data durability guarantee.
   */
  Default: "default",
  /**
   * Writes to the stream are committed, but writes to the disk are asynchronously synced.
   * The publish acknowledgement is sent before the sync to the disk is complete.
   * This could result in data-loss if the server crashes before the sync is completed, however
   * with an R3+ stream, the replication provides in-flight redundancy to reduce the likelihood of
   * this occurring with distinct fault domains.
   * This can significantly increase the publish throughput.
   */
  Async: "async"
}

/** @since 1.0.0 */
export type PersistMode = typeof PersistMode[keyof typeof PersistMode]

/**
 * Options for StreamAPI info requests
 * @since 1.0.0
 */
export type StreamInfoRequestOptions = {
  /**
   * Include info on deleted subjects.
   */
  "deleted_details": boolean

  /**
   * Only include information matching the specified subject filter
   */
  "subjects_filter": string
} & ApiPagedRequest

/** @since 1.0.0 */
export type MsgRequest = SeqMsgRequest | LastForMsgRequest

/**
 * Request the first message matching specified subject found on or after the specified optional sequence.
 * @since 1.0.0
 */
export type NextMsgRequest = { seq?: number; next_by_subj: string }

/**
 * Retrieves the last message with the given subject
 * @since 1.0.0
 */
export type LastForMsgRequest = { "last_by_subj": string }

/**
 * Stream sequence number of the message to retrieve
 * @since 1.0.0
 */
export type SeqMsgRequest = { seq: number }

/**
 * Start time for the message. This is only supported on servers
 * 2.11.0 and better.
 * @since 1.0.0
 */
export type StartTimeMsgRequest = { start_time: Date | string }

/** @since 1.0.0 */
export type DirectMsgRequest =
  | SeqMsgRequest
  | LastForMsgRequest
  | NextMsgRequest
  | StartTimeMsgRequest

/** @since 1.0.0 */
export type CompletionResult = { err?: Error }

/** @since 1.0.0 */
export type BatchCallback<T> = (
  done: Option.Option<CompletionResult>,
  message: Option.Option<T>
) => void | Effect.Effect<void, unknown>

/** @since 1.0.0 */
export type DirectBatch = {
  batch: number
}

/** @since 1.0.0 */
export type DirectMaxBytes = MaxBytes

/** @since 1.0.0 */
export type DirectBatchLimits = {
  batch: number

  max_bytes: number

  callback: BatchCallback<StoredMsg>

  next_by_subj?: string
}

/** @since 1.0.0 */
export type DirectBatchStartSeq = Partial<DirectBatchLimits> & {
  seq: number

  start_time?: never
}

/** @since 1.0.0 */
export type DirectBatchStartTime = Partial<DirectBatchLimits> & {
  start_time: Date | string

  seq?: never
}

/** @since 1.0.0 */
export type DirectBatchOptions = DirectBatchStartSeq | DirectBatchStartTime

/** @since 1.0.0 */
export type DirectLastFor = {
  multi_last: Array<string>

  up_to_time?: Date | string

  up_to_seq?: number
} & Partial<DirectBatchLimits>

/** @since 1.0.0 */
export type StreamState = {
  /**
   * Number of messages stored in the Stream
   */
  messages: number

  /**
   * Combined size of all messages in the Stream
   */
  bytes: number

  /**
   * Sequence number of the first message in the Stream
   */
  "first_seq": number

  /**
   * The ISO timestamp of the first message in the Stream
   */
  "first_ts": string

  /**
   * Sequence number of the last message in the Stream
   */
  "last_seq": number

  /**
   * The ISO timestamp of the last message in the Stream
   */
  "last_ts": string

  /**
   * The number of deleted messages
   */
  "num_deleted": number

  /**
   * IDs of messages that were deleted using the Message Delete API or Interest-based streams removing messages out of order
   * when `StreamInfoRequestOptions.deleted_details` is specified on
   * the request.
   */
  deleted: Array<number>

  /**
   * Messages that were damaged and unrecoverable
   */
  lost?: LostStreamData

  /**
   * Number of Consumers attached to the Stream
   */
  "consumer_count": number

  /**
   * The number of unique subjects held in the stream
   */
  num_subjects?: number

  /**
   * Subjects and their message counts when a {@link StreamInfoRequestOptions | subjects_filter} was set
   */
  subjects?: Record<string, number>
}

/**
 * Records messages that were damaged and unrecoverable
 * @since 1.0.0
 */
export type LostStreamData = {
  /**
   * The messages that were lost
   */
  msgs: Array<number> | null

  /**
   * The number of bytes that were lost
   */
  bytes: number
}

/** @since 1.0.0 */
export type ClusterInfo = {
  /**
   * The cluster name
   */
  name?: string

  /**
   * The server name of the RAFT leader
   */
  leader?: string

  /**
   * The members of the RAFT cluster
   */
  replicas?: Array<PeerInfo>

  /**
   * Name of the raft group managing the asset
   */
  raft_group?: string

  /**
   * The ISO timestamp when the RAFT leader was elected.
   */
  leader_since?: string

  /**
   * The account through which the cluster traffic flows through
   */
  traffic_account?: string

  /**
   * True if the traffic_account is a system account
   */
  system_account?: boolean
}

/** @since 1.0.0 */
export type PeerInfo = {
  /**
   * The server name of the peer
   */
  name: string

  /**
   * Indicates if the server is up-to-date and synchronised
   */
  current: boolean

  /**
   * Indicates the node is considered offline by the group
   */
  offline: boolean

  /**
   * Nanoseconds since this peer was last seen
   */
  active: Nanos

  /**
   * How many uncommitted operations this peer is behind the leader
   */
  lag: number
}

/**
 * Information about an upstream stream source in a mirror
 * @since 1.0.0
 */
export type StreamSourceInfo = {
  /**
   * The name of the Stream being replicated
   */
  name: string

  /**
   * How many messages behind the mirror operation is
   */
  lag: number

  /**
   * When last the mirror had activity, in nanoseconds. Value will be -1 when there has been no activity.
   */
  active: Nanos

  /**
   * A possible error
   */
  error?: ApiError

  /**
   * Apply a subject transforms to sourced messages before doing anything else.
   * This feature only supported on 2.10.x and better.
   */
  subject_transforms?: Array<SubjectTransformConfig>
}

/** @since 1.0.0 */
export type PurgeOpts = PurgeBySeq | PurgeTrimOpts | PurgeBySubject

/** @since 1.0.0 */
export type PurgeBySeq = {
  /**
   * Restrict purging to messages that match this subject
   */
  filter?: string

  /**
   * Purge all messages up to but not including the message with this sequence.
   */
  seq: number
}

/** @since 1.0.0 */
export type PurgeTrimOpts = {
  /**
   * Restrict purging to messages that match this subject
   */
  filter?: string

  /**
   * Ensures this many messages are present after the purge.
   */
  keep: number
}

/** @since 1.0.0 */
export type PurgeBySubject = {
  /**
   * Restrict purging to messages that match this subject
   */
  filter: string
}

/** @since 1.0.0 */
export type PurgeResponse = Success & {
  /**
   * Number of messages purged from the Stream
   */
  purged: number
}

/** @since 1.0.0 */
export type ConsumerCreateOptions = {
  /**
   * If true, the server will check that the consumer configuration aligns with
   * stream settings that affect the consumer.
   */
  pedantic?: boolean
}

/**
 * Additional options that express the intention of the API
 * @since 1.0.0
 */
export type ConsumerApiOptions = {
  action?: ConsumerApiAction

  pedantic?: boolean
}

/** @since 1.0.0 */
export const ConsumerApiAction = {
  CreateOrUpdate: "",
  Update: "update",
  Create: "create"
} as const

/** @since 1.0.0 */
export type ConsumerApiAction = typeof ConsumerApiAction[keyof typeof ConsumerApiAction]

/** @since 1.0.0 */
export type CreateConsumerRequest = {
  "stream_name": string

  config: Partial<ConsumerConfig>

  action?: ConsumerApiAction

  pedantic?: boolean
}

/** @since 1.0.0 */
export type StreamMsgResponse = ApiResponse & {
  message: {
    subject: string

    seq: number

    data: string

    hdrs: string

    time: string
  }
}

/** @since 1.0.0 */
export type SequenceInfo = {
  "consumer_seq": number

  "stream_seq": number

  "last_active"?: string
}

/** @since 1.0.0 */
export type ConsumerInfo = {
  /**
   * The stream hosting the consumer
   */
  "stream_name": string

  /**
   * A unique name for the consumer, either machine generated or the durable name
   */
  name: string

  /**
   * The ISO timestamp when the Consumer was created
   */
  created: string

  /**
   * The consumer configuration
   */
  config: ConsumerConfig

  /**
   * The last message delivered from this Consumer
   */
  delivered: SequenceInfo

  /**
   * The highest contiguous acknowledged message
   */
  "ack_floor": SequenceInfo

  /**
   * The number of messages pending acknowledgement
   * but yet to acknowledged by the client.
   */
  "num_ack_pending": number

  /**
   * The number of redeliveries that have been performed
   */
  "num_redelivered": number

  /**
   * The number of pull consumers waiting for messages
   */
  "num_waiting": number

  /**
   * The number of messages left unconsumed in this Consumer
   */
  "num_pending": number

  /**
   * The cluster where the consumer is defined
   */
  cluster?: ClusterInfo

  /**
   * Indicates if any client is connected and receiving messages from a push consumer
   */
  "push_bound": boolean

  /**
   * The ISO timestamp when the ConsumerInfo was generated. This field is only available
   * on servers 2.10.x or better
   */
  "ts"?: string

  /**
   * Set to true if the consumer is paused.
   * This field is only available on servers 2.11.x or better
   */
  paused?: boolean

  /**
   * If the consumer was paused with a resume date, this field specifies the amount of time
   * in nanoseconds remaining until the consumer will be automatically resumed. This field
   * is only available on servers 2.11.x or better
   */
  "pause_remaining": Nanos
}

/** @since 1.0.0 */
export type ConsumerListResponse = ApiResponse & ApiPaged & {
  consumers: Array<ConsumerInfo>
}

/**
 * Response from `$JS.API.CONSUMER.RESET` containing the reset
 * ConsumerInfo plus the stream sequence the consumer was reset to.
 *
 * Requires server v2.14.0+. See ADR-60.
 * @since 1.0.0
 */
export type ConsumerResetResponse = ConsumerInfo & {
  /**
   * The stream sequence the consumer was reset to. The next
   * message delivered will have sequence >= reset_seq.
   */
  reset_seq: number
}

/** @since 1.0.0 */
export type StreamListResponse = ApiResponse & ApiPaged & {
  streams: Array<StreamInfo>
}

/** @since 1.0.0 */
export type Success = {
  /**
   * True if the operation succeeded
   */
  success: boolean
}

/** @since 1.0.0 */
export type SuccessResponse = ApiResponse & Success

/** @since 1.0.0 */
export type MsgDeleteRequest = SeqMsgRequest & {
  /**
   * Default will securely remove a message and rewrite the data with random data,
   * set this to true to only remove the message
   */
  "no_erase"?: boolean
}

/** @since 1.0.0 */
export type AccountLimits = {
  /**
   * The maximum amount of Memory storage Stream Messages may consume
   */
  "max_memory": number

  /**
   * The maximum amount of File storage Stream Messages may consume
   */
  "max_storage": number

  /**
   * The maximum number of Streams an account can create
   */
  "max_streams": number

  /**
   * The maximum number of Consumer an account can create
   */
  "max_consumers": number

  /**
   * The maximum number of outstanding ACKs any consumer may configure
   */
  "max_ack_pending": number

  /**
   * The maximum size any single memory stream may be
   */
  "memory_max_stream_bytes": number

  /**
   * The maximum size any single storage based stream may be
   */
  "storage_max_stream_bytes": number

  /**
   * Indicates if Streams created in this account requires the max_bytes property set
   */
  "max_bytes_required": boolean
}

/** @since 1.0.0 */
export type JetStreamUsage = {
  /**
   * Memory Storage being used for Stream Message storage
   */
  memory: number

  /**
   * File Storage being used for Stream Message storage
   */
  storage: number

  /**
   * Reserved Memory storage
   */
  reserved_memory: number

  /**
   * Reserved File storage
   */
  reserved_storage: number

  /**
   * Number of active Streams
   */
  streams: number

  /**
   * "Number of active Consumers
   */
  consumers: number
}

/** @since 1.0.0 */
export type JetStreamUsageAccountLimits = JetStreamUsage & {
  limits: AccountLimits
}

/** @since 1.0.0 */
export type JetStreamAccountStats = JetStreamUsageAccountLimits & {
  api: JetStreamApiStats

  domain?: string

  tiers?: Partial<Record<`R${number}`, JetStreamUsageAccountLimits>>
}

/** @since 1.0.0 */
export type JetStreamApiStats = {
  /**
   * The active JetStream API level for this server
   */
  level?: number

  /**
   * Total number of API requests received for this account
   */
  total: number

  /**
   * API requests that resulted in an error response
   */
  errors: number

  /**
   * Number of API requests currently being processed
   */
  inflight?: number
}

/** @since 1.0.0 */
export type AccountInfoResponse = ApiResponse & JetStreamAccountStats

/** @since 1.0.0 */
export type PriorityGroups = {
  priority_groups?: Array<string>

  priority_policy?: PriorityPolicy

  priority_timeout?: Nanos
}

/** @since 1.0.0 */
export type ConsumerConfig = ConsumerUpdateConfig & {
  /**
   * The type of acknowledgment required by the Consumer
   */
  "ack_policy": AckPolicy

  /**
   * Where to start consuming messages on the stream
   */
  "deliver_policy": DeliverPolicy

  /**
   * Allows push consumers to form a queue group
   */
  "deliver_group"?: string

  /**
   * A unique name for a durable consumer. Set `name` for ephemeral consumers
   */
  "durable_name"?: string

  /**
   * The consumer name
   */
  name?: string

  /**
   * For push consumers this will regularly send an empty mess with Status header 100
   * and a reply subject, consumers must reply to these messages to control
   * the rate of message delivery.
   */
  "flow_control"?: boolean

  /**
   * If the Consumer is idle for more than this many nanoseconds an empty message with
   * Status header 100 will be sent indicating the consumer is still alive
   */
  "idle_heartbeat"?: Nanos

  /**
   * The sequence from which to start delivery messages.
   * Requires {@link DeliverPolicy#StartSequence}
   */
  "opt_start_seq"?: number

  /**
   * The date time from which to start delivering messages
   * Requires {@link DeliverPolicy#StartTime}
   */
  "opt_start_time"?: string

  /**
   * The rate at which messages will be delivered to clients, expressed in bytes per second
   */
  "rate_limit_bps"?: number

  /**
   * How messages are played back to the Consumer
   */
  "replay_policy": ReplayPolicy

  /**
   * Creates a consumer that is initially paused, but will resume at the specified Date and time.
   * Specified as an ISO date time string (Date#toISOString()).
   */
  "pause_until"?: string
}

/** @since 1.0.0 */
export type ConsumerUpdateConfig = PriorityGroups & {
  /** Pause delivery until this ISO timestamp. @since 1.0.0 */
  pause_until?: string
  /**
   * A short description of the purpose of this consume
   */
  description?: string

  /**
   * How long (in nanoseconds) to allow messages to remain un-acknowledged before attempting redelivery
   */
  "ack_wait"?: Nanos

  /**
   * The maximum number of times a message will be delivered to consumers if not acknowledged in time.
   * Default is -1 (will redeliver until acknowledged).
   */
  "max_deliver"?: number

  /**
   * @ignore
   */
  "sample_freq"?: string

  /**
   * The maximum number of messages without acknowledgement that can be outstanding,
   * once this limit is reached message delivery will be suspended
   */
  "max_ack_pending"?: number

  /**
   * The number of pulls that can be outstanding on a pull consumer,
   * pulls received after this is reached are ignored
   */
  "max_waiting"?: number

  /**
   * Delivers only the headers of messages in the stream and not the bodies. Additionally,
   * adds Nats-Msg-Size {@link JsHeaders#MessageSizeHdr} header to indicate the size of
   * the removed payload
   */
  "headers_only"?: boolean

  /**
   * The subject where the push consumer should be sent the messages
   */
  "deliver_subject"?: string

  /**
   * The largest batch property that may be specified when doing a pull on a Pull Consumer
   */
  "max_batch"?: number

  /**
   * The maximum expires value that may be set when doing a pull on a Pull Consumer expressed in nanoseconds.
   */
  "max_expires"?: Nanos

  /**
   * Duration that instructs the server to clean up ephemeral consumers that are inactive for the specified
   * time in nanoseconds
   */
  "inactive_threshold"?: Nanos

  /**
   * List of durations in nanoseconds that represents a retry timescale for
   * the redelivery of messages
   */
  "backoff"?: Array<Nanos>

  /**
   * The maximum bytes value that maybe set when dong a pull on a Pull Consumer
   */
  "max_bytes"?: number

  /**
   * When set do not inherit the replica count from the stream but specifically set it to this amount.
   */
  "num_replicas"?: number

  /**
   * Force the consumer state to be kept in memory rather than inherit the setting from the stream
   */
  "mem_storage"?: boolean

  /**
   * Deliver only messages that match the subject filter
   * This is exclusive of `filter_subjects`
   */
  "filter_subject"?: string

  /**
   * Deliver only messages that match the specified filters.
   * This is exclusive of `filter_subject`.
   */
  "filter_subjects"?: Array<string>

  /**
   * Metadata field to store additional information about the consumer. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>
}

/** @since 1.0.0 */
export const PriorityPolicy = {
  None: "none",
  Overflow: "overflow",
  PinnedClient: "pinned_client",
  Prioritized: "prioritized"
} as const

/** @since 1.0.0 */
export type PriorityPolicy = typeof PriorityPolicy[keyof typeof PriorityPolicy]

/** @since 1.0.0 */
export function defaultConsumer(
  name: string,
  opts: Partial<ConsumerConfig> = {}
): ConsumerConfig {
  return Object.assign({
    name: name,
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: 30_000_000_000,
    replay_policy: ReplayPolicy.Instant
  }, opts)
}

/** @since 1.0.0 */
export type OverflowMinPending = {
  /**
   * The name of the priority_group
   */
  group: string

  /**
   * Only deliver messages when num_pending for the consumer is greater than this value
   */
  min_pending: number
}

/** @since 1.0.0 */
export type OverflowMinAckPending = {
  /**
   * The name of the priority_group
   */
  group: string

  /**
   * Only deliver messages when num_ack_pending for the consumer is greater than this value
   */
  min_ack_pending: number
}

/** @since 1.0.0 */
export type OverflowMinPendingAndMinAck = {
  /**
   * The name of the priority_group
   */
  group: string

  /**
   * Only deliver messages when num_pending for the consumer is greater than this value
   */
  min_pending: number

  /**
   * Only deliver messages when num_ack_pending for the consumer is greater than this value
   */
  min_ack_pending: number
}

/** @since 1.0.0 */
export type OverflowOptions =
  | OverflowMinPending
  | OverflowMinAckPending
  | OverflowMinPendingAndMinAck

/** @since 1.0.0 */
export type PinnedOptions = {
  /**
   * The name of the group the consumer belongs to.
   */
  group: string

  /**
   * Overflow option is not valid
   */
  min_pending: never

  /**
   * Overflow option is not valid
   */
  min_ack_pending: never
}

/** @since 1.0.0 */
export type PrioritizedOptions = {
  group: string

  priority: number
}

/**
 * Options for a JetStream pull subscription which define how long
 * the pull request will remain open and limits the amount of data
 * that the server could return.
 * @since 1.0.0
 */
export type PullOptions =
  & Partial<OverflowMinPendingAndMinAck>
  & Partial<PrioritizedOptions>
  & {
    /**
     * Max number of messages to retrieve in a pull.
     */
    batch: number

    /**
     * If true, the request for messages will end when received by the server
     */
    "no_wait": boolean

    /**
     * If set, the number of milliseconds to wait for the number of messages
     * specified in `batch`
     */
    expires: number

    /**
     * If set, the max number of bytes to receive. The server will limit the
     * number of messages in the batch to fit within this setting.
     */
    "max_bytes": number

    /**
     * Number of nanos between messages for the server to emit an idle_heartbeat
     */
    "idle_heartbeat": number
  }

/** @since 1.0.0 */
export type DeliveryInfo = {
  /**
   * JetStream domain of the message if applicable.
   */
  domain: string

  /**
   * The hash of the sending account if applicable.
   */
  "account_hash"?: string

  /**
   * The stream where the message came from
   */
  stream: string

  /**
   * The intended consumer for the message.
   */
  consumer: string

  /**
   * The number of times the message has been delivered.
   */
  deliveryCount: number

  /**
   * The sequence number of the message in the stream
   */
  streamSequence: number

  /**
   * The client delivery sequence for the message
   */
  deliverySequence: number

  /**
   * The timestamp for the message in nanoseconds. Convert with `millis(n)`,
   */
  timestampNanos: number

  /**
   * The number of pending messages for the consumer at the time the
   * message was delivered.
   */
  pending: number

  /**
   * True if the message has been redelivered.
   */
  redelivered: boolean
}

/** @since 1.0.0 */
export const PubHeaders = {
  MsgIdHdr: "Nats-Msg-Id",
  ExpectedStreamHdr: "Nats-Expected-Stream",
  ExpectedLastSeqHdr: "Nats-Expected-Last-Sequence",
  ExpectedLastMsgIdHdr: "Nats-Expected-Last-Msg-Id",
  ExpectedLastSubjectSequenceHdr: "Nats-Expected-Last-Subject-Sequence",
  ExpectedLastSubjectSequenceSubjectHdr: "Nats-Expected-Last-Subject-Sequence-Subject",
  /**
   * Sets the TTL for a message (Nanos value). Only have effect on streams that
   * enable `StreamConfig.allow_msg_ttl`.
   */
  MessageTTL: "Nats-TTL",
  Schedule: "Nats-Schedule",
  ScheduleTarget: "Nats-Schedule-Target",
  ScheduleSource: "Nats-Schedule-Source",
  ScheduleTTL: "Nats-Schedule-TTL",
  ScheduleTimeZone: "Nats-Schedule-Time-Zone",
  ScheduleRollup: "Nats-Schedule-Rollup",
  /**
   * Set on messages produced by the scheduler. Holds the subject of the
   * schedule that produced the message. Also used by clients to atomically
   * cancel a schedule (set together with `ScheduleNext: "purge"`).
   */
  Scheduler: "Nats-Scheduler",
  /**
   * Set on messages produced by the scheduler. Holds the timestamp of the
   * next invocation for cron schedules, or `purge` for delayed messages.
   * Also used by clients with value `purge` to atomically cancel a schedule.
   */
  ScheduleNext: "Nats-Schedule-Next"
} as const

/** @since 1.0.0 */
export type PubHeaders = typeof PubHeaders[keyof typeof PubHeaders]

/** @since 1.0.0 */
export type JetStreamOptions = {
  /** Whether manager acquisition verifies the account API. @since 1.0.0 */
  checkAPI?: boolean
  /**
   * Prefix required to interact with JetStream. Must match
   * server configuration.
   */
  apiPrefix?: string

  /**
   * Number of milliseconds to wait for a JetStream API request.
   * @default ConnectionOptions.timeout
   * @see ConnectionOptions.timeout
   */
  timeout?: number

  /**
   * Name of the JetStream domain. This value automatically modifies
   * the default JetStream apiPrefix.
   */
  domain?: string

  /**
   * Watcher prefix for inbox subscriptions - these are used for watchers
   * and push consumers. If not set, it uses ConnectionOptions#inboxPrefix
   */
  watcherPrefix?: string
}

/** @since 1.0.0 */
export type JetStreamManagerOptions = JetStreamOptions & {
  /**
   * Allows disabling a check on the account for JetStream enablement see
   * {@link JetStreamManager.getAccountInfo()}.
   */
  checkAPI?: boolean

  /**
   * @ignore
   * Send the `Nats-Required-Api-Level` header on stream/consumer create/update
   * requests when the supplied config uses fields that require a minimum
   * server API level (per ADR-44). Server rejects with `api level not supported`
   * if its level is lower, instead of silently dropping unknown fields.
   */
  sendRequiredApiLevel?: boolean
}

/**
 * The response returned by the JetStream server when a message is added to a stream.
 * @since 1.0.0
 */
export type PubAck = {
  /**
   * The name of the stream
   */
  stream: string

  /**
   * The domain of the JetStream
   */
  domain?: string

  /**
   * The sequence number of the message as stored in JetStream
   */
  seq: number

  /**
   * True if the message is a duplicate
   */
  duplicate: boolean
}

/**
 * Predefined cron-like schedule aliases.
 * Requires server v2.14.0+.
 * @since 1.0.0
 */
export type PredefinedSchedule =
  | "@yearly"
  | "@annually"
  | "@monthly"
  | "@weekly"
  | "@daily"
  | "@midnight"
  | "@hourly"

/**
 * Typed schedule specification. Converted to the appropriate
 * `Nats-Schedule` header value at publish time.
 *
 * - `at`: single-shot fire at the given instant. Server v2.12.0+.
 * - `every`: repeat at a fixed interval. Minimum 1s. Server v2.14.0+.
 * - `cron`: 6-field cron expression (`sec min hr dom mon dow`). Server v2.14.0+.
 * - `predefined`: named cron alias. Server v2.14.0+.
 * @since 1.0.0
 */
export type ScheduleSpec =
  | { at: Date | string }
  | { every: string }
  | { cron: string }
  | { predefined: PredefinedSchedule }

/** @since 1.0.0 */
export type ScheduleOptions = {
  /**
   * The schedule specification.
   *
   * Accepts:
   * - {@link ScheduleSpec} - typed builder (preferred).
   * - `Date` - convenience for single-shot `@at <iso>`.
   * - `string` - raw header value (e.g. `"@every 1s"`, `"0 0 5 * * *"`,
   *   `"@at 2026-01-01T00:00:00Z"`).
   *
   * Server support per format:
   * - `@at` - v2.12.0+
   * - `@every`, cron, predefined, timezone - v2.14.0+
   */
  specification: string | Date | ScheduleSpec

  /**
   * The subject the message will be delivered to
   */
  target: string

  /**
   * Instructs the schedule to read the last message on the given subject and publish. If the subject is empty, nothing is published. Wildcards are NOT supported.
   */
  source?: string

  /**
   * Sets a message TTL if the stream supports per-message TTL.
   */
  ttl?: string

  /**
   * IANA timezone name (e.g. `"America/Denver"`). Applies to cron and
   * predefined schedules only. Requires server v2.14.0+.
   */
  timezone?: string

  /**
   * Per-subject rollup behavior on the target stream. Only `"sub"` is
   * defined. Requires server v2.14.0+.
   */
  rollup?: "sub"
}

/**
 * StreamExpectations are used implement some assertions before adding a message
 * to the stream.
 * @since 1.0.0
 */
export type StreamExpectations = {
  /**
   * The expected last msgID of the last message received by the stream.
   */
  lastMsgID: string

  /**
   * The expected stream capturing the message
   */
  streamName: string

  /**
   * The expected last sequence on the stream.
   */
  lastSequence: number

  /**
   * The expected last sequence on the stream for a message with this subject
   */
  lastSubjectSequence: number

  /**
   * This option is used in conjunction with {@link lastSubjectSequence}. It enables a
   * constraint on the sequence to be based on the specified subject (which can
   * have wildcards) rather than the subject of the message being published.
   *
   * Here's an example set of sequences for specific subjects:
   *
   * ┌─────────┬────────┐
   * │ subj    │ Seq    │
   * ├─────────┼────────┤
   * │ a.1.foo │ 1      │
   * │ a.1.bar │ 6      │
   * │ a.2.foo │ 3      │
   * │ a.3.bar │ 4      │
   * │ a.1.baz │ 5      │
   * │ a.2.baz │ 7      │
   * └─────────┴────────┘
   *
   *  The LastSubjectSequenceSubject for wildcards in the last token
   *  Are evaluated for to the largest sequence matching the subject:
   * ┌────────────────────┬────────┐
   * | Last Subj Seq Subj | Seq    |
   * ├────────────────────┼────────┤
   * │ a.1.*              │ 6      │
   * │ a.2.*              │ 7      │
   * │ a.3.*              │ 4      │
   * └────────────────────┴────────┘
   */
  lastSubjectSequenceSubject: string

  /**
   * The expected last sequence on the stream for a message with this subject
   * and this value.
   */
  lastSubjectSequenceValue: number
}

/**
 * Options for messages published to JetStream
 * @since 1.0.0
 */
export type JetStreamPublishOptions = {
  /**
   * A string identifier used to detect duplicate published messages.
   * If the msgID is reused within the stream's `duplicate_window`,
   * the message will be rejected by the stream, and the {@link PubAck} will
   * mark it as a `duplicate`.
   */
  msgID: string

  /**
   * The number of milliseconds to wait for the PubAck
   */
  timeout: number

  /**
   * Headers associated with the message. You can create an instance of
   * MsgHdrs with the headers() function.
   */
  headers: MsgHdrs

  /**
   * Set of constraints that when specified are verified by the server.
   * If the constraint(s) doesn't match, the server will reject the message.
   * These settings allow you to implement deduplication and consistency
   * strategies.
   */
  expect: Partial<StreamExpectations>

  /**
   * Sets {@link PubHeaders.MessageTTL} this only applies to streams that enable
   * `StreamConfig.allow_msg_ttl`. The format of this value is "1s" or "1h",
   * etc, or a plain number interpreted as the number of seconds.
   */
  ttl?: string

  /**
   * Continue to attempt to publish if the publish fails due to a no responders error.
   * Default is 1.
   */
  retries?: number

  /**
   * Specifies the schedule for the message.
   */
  schedule?: ScheduleOptions

  /**
   * Atomically cancels a schedule as part of this publish. The published
   * message lands on its normal subject
 the named schedule is removed
   * server-side in the same operation.
   *
   * The publish subject MUST NOT equal {@link ScheduleCancellation.scheduleSubject}
   * (the server would purge the cancellation message itself).
   *
   * Combine with {@link StreamExpectations.lastSubjectSequence} +
   * {@link StreamExpectations.lastSubjectSequenceSubject} to make the cancel
   * conditional on the schedule still existing at a given sequence.
   *
   * Requires server v2.14.0+.
   */
  cancelSchedule?: ScheduleCancellation
}

/**
 * Atomically cancel a schedule as part of a publish. See
 * {@link JetStreamPublishOptions.cancelSchedule}.
 * @since 1.0.0
 */
export type ScheduleCancellation = {
  /**
   * Subject of the schedule to cancel. Sent as the `Nats-Scheduler` header.
   */
  scheduleSubject: string
}

/**
 * ConsumerNotifications are informational notifications emitted by ConsumerMessages
 * that may be of interest to a client.
 * @since 1.0.0
 */
export type ConsumerNotification =
  | HeartbeatsMissed
  | ConsumerNotFound
  | StreamNotFound
  | ConsumerDeleted
  | OrderedConsumerRecreated
  | ExceededLimits
  | Debug
  | Discard
  | Reset
  | Next
  | Heartbeat
  | FlowControl
  | NoResponders
  | ConsumerPinned
  | ConsumerUnpinned

/**
 * Notification that heartbeats were missed. This notification is informational.
 * The `data` portion of the status, is a number indicating the number of missed heartbeats.
 * Note that when a client disconnects, heartbeat tracking is paused while
 * the client is disconnected.
 * @since 1.0.0
 */
export type HeartbeatsMissed = {
  type: "heartbeats_missed"

  count: number
}

/**
 * Notification that the consumer was not found. Consumers that were accessible at
 * least once, will be retried for more messages regardless of the not being found
 * or timeouts etc. This notification includes a count of consecutive attempts to
 * find the consumer. Note that if you get this notification possibly your code should
 * attempt to recreate the consumer. Note that this notification is only informational
 * for ordered consumers, as the consumer will be created in those cases automatically.
 * @since 1.0.0
 */
export type ConsumerNotFound = {
  type: "consumer_not_found"

  name: string

  stream: string

  count: number
}

/**
 * Notification that the stream was not found. Consumers were accessible at least once,
 * will be retried for more messages regardless of the not being found
 * or timeouts etc. This notification includes a count of consecutive attempts to
 * find the consumer. Note that if you get this notification possibly your code should
 * attempt to recreate the consumer. Note that this notification is only informational
 * for ordered consumers, as the consumer will be created in those cases automatically.
 * @since 1.0.0
 */
export type StreamNotFound = {
  type: "stream_not_found"

  name: string

  consumerCreateFails?: number
}

/**
 * Notification that the consumer was deleted. This notification
 * means the consumer will not get messages unless it is recreated. The client
 * will continue to attempt to pull messages. Ordered consumer will recreate it.
 * @since 1.0.0
 */
export type ConsumerDeleted = {
  type: "consumer_deleted"

  code: number

  description: string
}

/**
 * Notification that a JetStream request didn't get a response due to a timeout
 * or JetStream not being available.
 * @since 1.0.0
 */
export type NoResponders = {
  type: "no_responders"

  code: number
}

/**
 * This notification is specific of ordered consumers and will be notified whenever
 * the consumer is recreated. The argument is the name of the newly created consumer.
 * @since 1.0.0
 */
export type OrderedConsumerRecreated = {
  type: "ordered_consumer_recreated"

  name: string
}

/**
 * This notification is specific to pull consumers and will be notified whenever
 * the pull request exceeds some limit such as maxwaiting, maxrequestbatch, etc.
 * The data component has the code (409) and the message from the server.
 * @since 1.0.0
 */
export type ExceededLimits = {
  type: "exceeded_limits"

  code: number

  description: string
}

/**
 * DebugEvents are effectively statuses returned by the server that were ignored
 * by the client. The `code` and `description` indicate the server specified code and description.
 * @since 1.0.0
 */
export type Debug = {
  type: "debug"

  code: number

  description: string
}

/**
 * Requests for messages can be terminated by the server, these notifications
 * provide information on the number of messages and/or bytes that couldn't
 * be satisfied by the consumer request.
 * @since 1.0.0
 */
export type Discard = {
  type: "discard"

  messagesLeft: number

  bytesLeft: number
}

/**
 * Notifies that the current consumer will be reset
 * @since 1.0.0
 */
export type Reset = {
  type: "reset"

  name: string
}

/**
 * Notifies whenever there's a request for additional messages from the server.
 * This notification telegraphs the request options, which should be treated as
 * read-only. This notification is only useful for debugging. Data is PullOptions.
 * @since 1.0.0
 */
export type Next = {
  type: "next"

  options: PullOptions
}

/**
 * Notifies that the client received a server-side heartbeat. The payload the data
 * portion has the format `{natsLastConsumer: number, natsLastStream: number}`
 * @since 1.0.0
 */
export type Heartbeat = {
  type: "heartbeat"

  lastConsumerSequence: number

  lastStreamSequence: number
}

/**
 * Notifies that the client received a server-side flow control message.
 * The data is null.
 * @since 1.0.0
 */
export type FlowControl = {
  type: "flow_control"
}

/** @since 1.0.0 */
export type ConsumerPinned = {
  type: "consumer_pinned"

  id: string
}

/** @since 1.0.0 */
export type ConsumerUnpinned = {
  type: "consumer_unpinned"
}

/**
 * These options are a subset of {@link ConsumerConfig} and
 * {@link ConsumerUpdateConfig}
 * @since 1.0.0
 */
export type OrderedConsumerOptions = {
  name_prefix: string

  filter_subjects: Array<string> | string

  deliver_policy: DeliverPolicy

  opt_start_seq: number

  opt_start_time: string

  replay_policy: ReplayPolicy

  inactive_threshold: number

  headers_only: boolean
}

/** @since 1.0.0 */
export type OrderedPushConsumerOptions = OrderedConsumerOptions & {
  deliver_prefix: string
}

/** @since 1.0.0 */
export type BatchMessageOptions =
  & Partial<Omit<JetStreamPublishOptions, "msgID" | "expect">>
  & {
    expect?: Partial<Omit<StreamExpectations, "lastMsgID">>
  }

/** @since 1.0.0 */
export type BatchMessageOptionsWithReply = {
  /**
   * Request acknowledgement of the message (only set this on some of the
   * messages, as this introduces a round trip to the server)
   */
  ack: boolean
} & Partial<BatchMessageOptions>

/** @since 1.0.0 */
export type BatchAck = {
  batch: string

  count: number
} & PubAck

/**
 * An advisory is an interesting event in the JetStream server
 * @since 1.0.0
 */
export type Advisory = {
  /**
   * The type of the advisory
   */
  kind: AdvisoryKind

  /**
   * Payload associated with the advisory
   */
  data: unknown
}

/**
 * The different kinds of Advisories
 * @since 1.0.0
 */
export const AdvisoryKind = {
  API: "api_audit",
  StreamAction: "stream_action",
  ConsumerAction: "consumer_action",
  SnapshotCreate: "snapshot_create",
  SnapshotComplete: "snapshot_complete",
  RestoreCreate: "restore_create",
  RestoreComplete: "restore_complete",
  MaxDeliver: "max_deliver",
  Terminated: "terminated",
  Ack: "consumer_ack",
  StreamLeaderElected: "stream_leader_elected",
  StreamQuorumLost: "stream_quorum_lost",
  ConsumerLeaderElected: "consumer_leader_elected",
  ConsumerQuorumLost: "consumer_quorum_lost"
} as const

/** @since 1.0.0 */
export type AdvisoryKind = typeof AdvisoryKind[keyof typeof AdvisoryKind]

/** @since 1.0.0 */
export const JsHeaders = {
  /**
   * Set if message is from a stream source - format is `stream seq`
   */
  StreamSourceHdr: "Nats-Stream-Source",
  /**
   * Set for heartbeat messages
   */
  LastConsumerSeqHdr: "Nats-Last-Consumer",
  /**
   * Set for heartbeat messages
   */
  LastStreamSeqHdr: "Nats-Last-Stream",
  /**
   * Set for heartbeat messages if the consumer is stalled, reply subject
   * will unstall the client when the client responds
   */
  ConsumerStalledHdr: "Nats-Consumer-Stalled",
  /**
   * Set for headers_only consumers indicates the number of bytes in the payload
   */
  MessageSizeHdr: "Nats-Msg-Size",
  // rollup header
  RollupHdr: "Nats-Rollup",
  // value for rollup header when rolling up a subject
  RollupValueSubject: "sub",
  // value for rollup header when rolling up all subjects
  RollupValueAll: "all",
  /**
   * Set on protocol messages to indicate pull request message count that
   * was not honored.
   */
  PendingMessagesHdr: "Nats-Pending-Messages",
  /**
   * Set on protocol messages to indicate pull request byte count that
   * was not honored
   */
  PendingBytesHdr: "Nats-Pending-Bytes",
  /**
   * Asserts a minimum JetStream API level on a JS API request (ADR-44).
   */
  RequiredApiLevel: "Nats-Required-Api-Level"
} as const

/** @since 1.0.0 */
export type JsHeaders = typeof JsHeaders[keyof typeof JsHeaders]

/** @since 1.0.0 */
export const DirectMsgHeaders = {
  Stream: "Nats-Stream",
  Sequence: "Nats-Sequence",
  TimeStamp: "Nats-Time-Stamp",
  Subject: "Nats-Subject",
  LastSequence: "Nats-Last-Sequence",
  NumPending: "Nats-Num-Pending"
} as const

/** @since 1.0.0 */
export type DirectMsgHeaders = typeof DirectMsgHeaders[keyof typeof DirectMsgHeaders]

/** @since 1.0.0 */
export const RepublishHeaders = {
  /**
   * The source stream of the message
   */
  Stream: "Nats-Stream",
  /**
   * The original subject of the message
   */
  Subject: "Nats-Subject",
  /**
   * The sequence of the republished message
   */
  Sequence: "Nats-Sequence",
  /**
   * The stream sequence id of the last message ingested to the same original subject (or 0 if none or deleted)
   */
  LastSequence: "Nats-Last-Sequence",
  /**
   * The size in bytes of the message's body - Only if {@link Republish#headers_only} is set.
   */
  Size: "Nats-Msg-Size"
} as const

/** @since 1.0.0 */
export type RepublishHeaders = typeof RepublishHeaders[keyof typeof RepublishHeaders]

/** @since 1.0.0 */
export type Nanos = number
/** @since 1.0.0 */
export type MaxBytes = { max_bytes: number }
/** @since 1.0.0 */
export type StoredMsg = JetStreamStoredMessage.JetStreamStoredMessage
/** @since 1.0.0 */
export type MsgHdrs = NATSHeaders.MsgHdrs
/** @since 1.0.0 */
export interface FetchOptions {
  readonly max_messages?: number
  readonly max_bytes?: number
  readonly expires?: number
  readonly idle_heartbeat?: number
  readonly bind?: boolean
  readonly group?: string
  readonly min_pending?: number
  readonly min_ack_pending?: number
  readonly priority?: number
}
/** @since 1.0.0 */
export interface ConsumeOptions extends FetchOptions {
  readonly callback?: (
    message: JetStreamMessage.JetStreamMessage
  ) => void | Effect.Effect<void, unknown>
  readonly threshold_messages?: number
  readonly threshold_bytes?: number
  readonly abort_on_missing_resource?: boolean
}
/** @since 1.0.0 */
export interface NextOptions {
  readonly expires?: number
  readonly bind?: boolean
}
/** @since 1.0.0 */
export interface PushConsumerOptions {
  readonly callback?: NonNullable<ConsumeOptions["callback"]>
  readonly abort_on_missing_resource?: boolean
}
/** @since 1.0.0 */
export interface BoundPushConsumerOptions {
  readonly callback?: NonNullable<ConsumeOptions["callback"]>
  readonly idle_heartbeat?: number
  readonly deliver_subject: string
  readonly deliver_group?: string
}
