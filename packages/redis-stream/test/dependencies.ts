import { RedisConnection } from "@effect-messaging/redis-stream"
import { Effect } from "effect"

export const TestRedisConnection = RedisConnection.layer({
  host: "localhost",
  port: 6379
})
