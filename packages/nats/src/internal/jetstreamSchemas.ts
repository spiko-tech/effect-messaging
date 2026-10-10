/** Native JetStream wire decoders. @internal */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const ApiError = Schema.Struct({
  "code": Schema.Number,
  "description": Schema.String,
  "err_code": Schema.Number
})

export const DiscardPolicy = Schema.Literals(["old", "new"])

export const ExternalStream = Schema.Struct({
  "api": Schema.String,
  "deliver": Schema.optionalKey(Schema.String)
})

export const SubjectTransformConfig = Schema.Struct({
  "src": Schema.optionalKey(Schema.String),
  "dest": Schema.String
})

export const StreamConsumerSource = Schema.Struct({
  "name": Schema.String,
  "deliver_subject": Schema.String
})

export const StreamSource = Schema.Struct({
  "name": Schema.String,
  "opt_start_seq": Schema.optionalKey(Schema.Number),
  "opt_start_time": Schema.optionalKey(Schema.String),
  "filter_subject": Schema.optionalKey(Schema.String),
  "external": Schema.optionalKey(ExternalStream),
  "domain": Schema.optionalKey(Schema.String),
  "subject_transforms": Schema.optionalKey(Schema.Array(SubjectTransformConfig).pipe(Schema.mutable)),
  "consumer": Schema.optionalKey(StreamConsumerSource)
})

export const Placement = Schema.Struct({
  "cluster": Schema.String,
  "tags": Schema.Array(Schema.String).pipe(Schema.mutable)
})

export const Republish = Schema.Struct({
  "src": Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  "dest": Schema.String,
  "headers_only": Schema.optionalKey(Schema.Boolean)
})

export const StoreCompression = Schema.Literals(["none", "s2"])

export const StreamConsumerLimits = Schema.Struct({
  "inactive_threshold": Schema.optionalKey(Schema.Number),
  "max_ack_pending": Schema.optionalKey(Schema.Number)
})

export const RetentionPolicy = Schema.Literals(["limits", "interest", "workqueue"])

export const StorageType = Schema.Literals(["file", "memory"])

export const PersistMode = Schema.Literals(["default", "async"])

export const StreamConfig = Schema.Struct({
  "subjects": Schema.Array(Schema.String).pipe(Schema.mutable, Schema.withDecodingDefaultKey(Effect.succeed([]))),
  "description": Schema.optionalKey(Schema.String),
  "max_msgs_per_subject": Schema.Number,
  "max_msgs": Schema.Number,
  "max_age": Schema.Number,
  "max_bytes": Schema.Number,
  "max_msg_size": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "discard": DiscardPolicy,
  "discard_new_per_subject": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "no_ack": Schema.optionalKey(Schema.Boolean),
  "duplicate_window": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "sources": Schema.optionalKey(Schema.Array(StreamSource).pipe(Schema.mutable)),
  "allow_rollup_hdrs": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "num_replicas": Schema.Number,
  "placement": Schema.optionalKey(Placement),
  "deny_delete": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "deny_purge": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "allow_direct": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "mirror_direct": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "republish": Schema.optionalKey(Republish),
  "metadata": Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  "subject_transform": Schema.optionalKey(SubjectTransformConfig),
  "compression": Schema.optionalKey(StoreCompression),
  "consumer_limits": Schema.optionalKey(StreamConsumerLimits),
  "subject_delete_marker_ttl": Schema.optionalKey(Schema.Number),
  "mirror": Schema.optionalKey(StreamSource),
  "allow_msg_ttl": Schema.optionalKey(Schema.Boolean),
  "allow_msg_schedules": Schema.optionalKey(Schema.Boolean),
  "allow_atomic": Schema.optionalKey(Schema.Boolean),
  "allow_batched": Schema.optionalKey(Schema.Boolean),
  "name": Schema.String,
  "retention": RetentionPolicy,
  "storage": StorageType,
  "max_consumers": Schema.Number,
  "sealed": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "first_seq": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "allow_msg_counter": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "persist_mode": Schema.optionalKey(PersistMode)
})

export const LostStreamData = Schema.Struct({
  "msgs": Schema.Union([Schema.Array(Schema.Number).pipe(Schema.mutable), Schema.Null]),
  "bytes": Schema.Number
})

export const StreamState = Schema.Struct({
  "messages": Schema.Number,
  "bytes": Schema.Number,
  "first_seq": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "first_ts": Schema.String,
  "last_seq": Schema.Number,
  "last_ts": Schema.String,
  "num_deleted": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "deleted": Schema.Array(Schema.Number).pipe(Schema.mutable).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  "lost": Schema.optionalKey(LostStreamData),
  "consumer_count": Schema.Number,
  "num_subjects": Schema.optionalKey(Schema.Number),
  "subjects": Schema.optionalKey(Schema.Record(Schema.String, Schema.Number))
})

export const PeerInfo = Schema.Struct({
  "name": Schema.String,
  "current": Schema.Boolean,
  "offline": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "active": Schema.Number,
  "lag": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
})

export const ClusterInfo = Schema.Struct({
  "name": Schema.optionalKey(Schema.String),
  "leader": Schema.optionalKey(Schema.String),
  "replicas": Schema.optionalKey(Schema.Array(PeerInfo).pipe(Schema.mutable)),
  "raft_group": Schema.optionalKey(Schema.String),
  "leader_since": Schema.optionalKey(Schema.String),
  "traffic_account": Schema.optionalKey(Schema.String),
  "system_account": Schema.optionalKey(Schema.Boolean)
})

export const StreamSourceInfo = Schema.Struct({
  "name": Schema.String,
  "lag": Schema.Number,
  "active": Schema.Number,
  "error": Schema.optionalKey(ApiError),
  "subject_transforms": Schema.optionalKey(Schema.Array(SubjectTransformConfig).pipe(Schema.mutable))
})

export const StreamAlternate = Schema.Struct({
  "name": Schema.String,
  "cluster": Schema.String,
  "domain": Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
})

export const StreamInfo = Schema.Struct({
  "total": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "offset": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "limit": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "config": StreamConfig,
  "created": Schema.String,
  "state": StreamState,
  "cluster": Schema.optionalKey(ClusterInfo),
  "mirror": Schema.optionalKey(StreamSourceInfo),
  "sources": Schema.optionalKey(Schema.Array(StreamSourceInfo).pipe(Schema.mutable)),
  "alternates": Schema.optionalKey(Schema.Array(StreamAlternate).pipe(Schema.mutable)),
  "ts": Schema.optionalKey(Schema.String)
})

export const PriorityPolicy = Schema.Literals(["none", "overflow", "pinned_client", "prioritized"])

export const AckPolicy = Schema.Literals(["none", "all", "explicit", "flow_control", ""])

export const DeliverPolicy = Schema.Literals([
  "all",
  "last",
  "new",
  "by_start_sequence",
  "by_start_time",
  "last_per_subject"
])

export const ReplayPolicy = Schema.Literals(["instant", "original"])

export const ConsumerConfig = Schema.Struct({
  "priority_groups": Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.mutable)),
  "priority_policy": Schema.optionalKey(PriorityPolicy),
  "priority_timeout": Schema.optionalKey(Schema.Number),
  "description": Schema.optionalKey(Schema.String),
  "ack_wait": Schema.optionalKey(Schema.Number),
  "max_deliver": Schema.optionalKey(Schema.Number),
  "sample_freq": Schema.optionalKey(Schema.String),
  "max_ack_pending": Schema.optionalKey(Schema.Number),
  "max_waiting": Schema.optionalKey(Schema.Number),
  "headers_only": Schema.optionalKey(Schema.Boolean),
  "deliver_subject": Schema.optionalKey(Schema.String),
  "max_batch": Schema.optionalKey(Schema.Number),
  "max_expires": Schema.optionalKey(Schema.Number),
  "inactive_threshold": Schema.optionalKey(Schema.Number),
  "backoff": Schema.optionalKey(Schema.Array(Schema.Number).pipe(Schema.mutable)),
  "max_bytes": Schema.optionalKey(Schema.Number),
  "num_replicas": Schema.optionalKey(Schema.Number),
  "mem_storage": Schema.optionalKey(Schema.Boolean),
  "filter_subject": Schema.optionalKey(Schema.String),
  "filter_subjects": Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.mutable)),
  "metadata": Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  "ack_policy": AckPolicy,
  "deliver_policy": DeliverPolicy,
  "deliver_group": Schema.optionalKey(Schema.String),
  "durable_name": Schema.optionalKey(Schema.String),
  "name": Schema.optionalKey(Schema.String),
  "flow_control": Schema.optionalKey(Schema.Boolean),
  "idle_heartbeat": Schema.optionalKey(Schema.Number),
  "opt_start_seq": Schema.optionalKey(Schema.Number),
  "opt_start_time": Schema.optionalKey(Schema.String),
  "rate_limit_bps": Schema.optionalKey(Schema.Number),
  "replay_policy": ReplayPolicy,
  "pause_until": Schema.optionalKey(Schema.String)
})

export const SequenceInfo = Schema.Struct({
  "consumer_seq": Schema.Number,
  "stream_seq": Schema.Number,
  "last_active": Schema.optionalKey(Schema.String)
})

export const ConsumerInfo = Schema.Struct({
  "stream_name": Schema.String,
  "name": Schema.String,
  "created": Schema.String,
  "config": ConsumerConfig,
  "delivered": SequenceInfo,
  "ack_floor": SequenceInfo,
  "num_ack_pending": Schema.Number,
  "num_redelivered": Schema.Number,
  "num_waiting": Schema.Number,
  "num_pending": Schema.Number,
  "cluster": Schema.optionalKey(ClusterInfo),
  "push_bound": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "ts": Schema.optionalKey(Schema.String),
  "paused": Schema.optionalKey(Schema.Boolean),
  "pause_remaining": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
})

export const PubAck = Schema.Struct({
  "stream": Schema.String,
  "domain": Schema.optionalKey(Schema.String),
  "seq": Schema.Number,
  "duplicate": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
})

export const AccountLimits = Schema.Struct({
  "max_memory": Schema.Number,
  "max_storage": Schema.Number,
  "max_streams": Schema.Number,
  "max_consumers": Schema.Number,
  "max_ack_pending": Schema.Number,
  "memory_max_stream_bytes": Schema.Number,
  "storage_max_stream_bytes": Schema.Number,
  "max_bytes_required": Schema.Boolean
})

export const JetStreamApiStats = Schema.Struct({
  "level": Schema.optionalKey(Schema.Number),
  "total": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "errors": Schema.Number,
  "inflight": Schema.optionalKey(Schema.Number)
})

export const JetStreamUsageAccountLimits = Schema.Struct({
  "memory": Schema.Number,
  "storage": Schema.Number,
  "reserved_memory": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "reserved_storage": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "streams": Schema.Number,
  "consumers": Schema.Number,
  "limits": AccountLimits
})

export const JetStreamAccountStats = Schema.Struct({
  "memory": Schema.Number,
  "storage": Schema.Number,
  "reserved_memory": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "reserved_storage": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "streams": Schema.Number,
  "consumers": Schema.Number,
  "limits": AccountLimits,
  "api": JetStreamApiStats,
  "domain": Schema.optionalKey(Schema.String),
  "tiers": Schema.optionalKey(Schema.Record(Schema.String, JetStreamUsageAccountLimits))
})

export const PurgeResponse = Schema.Struct({
  "success": Schema.Boolean,
  "purged": Schema.Number
})

export const SuccessResponse = Schema.Struct({
  "type": Schema.String,
  "error": Schema.optionalKey(ApiError),
  "success": Schema.Boolean
})

export const StreamMsgResponse = Schema.Struct({
  "type": Schema.String,
  "error": Schema.optionalKey(ApiError),
  "message": Schema.Struct({
    "subject": Schema.String,
    "seq": Schema.Number,
    "data": Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
    "hdrs": Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
    "time": Schema.String
  })
})

export const ConsumerResetResponse = Schema.Struct({
  "stream_name": Schema.String,
  "name": Schema.String,
  "created": Schema.String,
  "config": ConsumerConfig,
  "delivered": SequenceInfo,
  "ack_floor": SequenceInfo,
  "num_ack_pending": Schema.Number,
  "num_redelivered": Schema.Number,
  "num_waiting": Schema.Number,
  "num_pending": Schema.Number,
  "cluster": Schema.optionalKey(ClusterInfo),
  "push_bound": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "ts": Schema.optionalKey(Schema.String),
  "paused": Schema.optionalKey(Schema.Boolean),
  "pause_remaining": Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  "reset_seq": Schema.Number
})

export const DeliveryInfo = Schema.Struct({
  "domain": Schema.String,
  "account_hash": Schema.optionalKey(Schema.String),
  "stream": Schema.String,
  "consumer": Schema.String,
  "deliveryCount": Schema.Number,
  "streamSequence": Schema.Number,
  "deliverySequence": Schema.Number,
  "timestampNanos": Schema.Number,
  "pending": Schema.Number,
  "redelivered": Schema.Boolean
})

export const BatchAck = Schema.Struct({
  "batch": Schema.String,
  "count": Schema.Number,
  "stream": Schema.String,
  "domain": Schema.optionalKey(Schema.String),
  "seq": Schema.Number,
  "duplicate": Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
})
