/**
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"

/**
 * Type alias for a consumer handler function that processes messages.
 *
 * @typeParam A - The response type that the handler must return (e.g., acknowledgment response)
 * @typeParam M - The message type that the handler receives via Effect context
 * @typeParam E - The error type that the handler may fail with
 * @typeParam R - Additional dependencies required by the handler (excluding the message type M)
 *
 * @since 0.3.0
 * @category models
 */
export type ConsumerApp<A, M, E = never, R = never> = Effect.Effect<A, E, R | M>
