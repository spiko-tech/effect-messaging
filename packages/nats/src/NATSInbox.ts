/**
 * Generate unique reply subjects with a validated namespace.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { NATSConnectionError } from "./NATSError.ts"

/**
 * An empty prefix uses `_INBOX`. Namespace tokens cannot be subject wildcards.
 * @since 1.0.0
 */
export const createInbox = (prefix = "_INBOX"): Effect.Effect<string, NATSConnectionError> =>
  Effect.gen(function*() {
    const namespace = yield* Schema.decodeUnknownEffect(Schema.String)(prefix || "_INBOX").pipe(
      Effect.mapError((cause) => new NATSConnectionError({ reason: "Inbox prefix must be a string", cause }))
    )
    if (namespace.split(".").some((token) => token === "*" || token === ">")) {
      return yield* new NATSConnectionError({
        reason: "Inbox prefix cannot contain wildcards",
        code: "invalid_argument"
      })
    }
    return `${namespace}.${crypto.randomUUID().replaceAll("-", "")}`
  })
