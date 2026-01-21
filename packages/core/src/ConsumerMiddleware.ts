/**
 * Middleware abstraction for consumer applications.
 *
 * Middleware allows you to transform consumer applications by wrapping
 * them with additional logic such as logging, error handling, or metrics.
 *
 * @since 0.8.0
 */
import type * as ConsumerApp from "./ConsumerApp.js"

/**
 * A middleware transforms a consumer application into another consumer application.
 *
 * @typeParam A - The response type that handlers must return
 * @typeParam M - The message type provided via Effect context
 * @typeParam EIn - The error type of the input application
 * @typeParam RIn - The dependencies of the input application
 * @typeParam EOut - The error type of the output application (defaults to EIn)
 * @typeParam ROut - The dependencies of the output application (defaults to RIn)
 *
 * @category models
 * @since 0.8.0
 */
export type ConsumerMiddleware<A, M, EIn = never, RIn = never, EOut = EIn, ROut = RIn> = (
  app: ConsumerApp.ConsumerApp<A, M, EIn, RIn>
) => ConsumerApp.ConsumerApp<A, M, EOut, ROut>

/**
 * Create a middleware from a function that transforms a consumer application.
 *
 * @category constructors
 * @since 0.8.0
 */
export const make = <A, M, EIn = never, RIn = never, EOut = EIn, ROut = RIn>(
  f: (app: ConsumerApp.ConsumerApp<A, M, EIn, RIn>) => ConsumerApp.ConsumerApp<A, M, EOut, ROut>
): ConsumerMiddleware<A, M, EIn, RIn, EOut, ROut> => f
