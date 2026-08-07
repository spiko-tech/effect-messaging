/**
 * Wraps an async iterable so that `return()` calls `stop` before delegating.
 *
 * nats-core iterators are async generators parked on an internal signal while nothing is queued, and
 * a generator queues `return()` behind that pending `next()`. Releasing the stream of an idle
 * subscription would therefore wait for the next message to arrive. Stopping the source first
 * settles the pending `next()` so `return()` completes right away.
 *
 * @internal
 */
export const stoppableIterable = <T>(iterable: AsyncIterable<T>, stop: () => void): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<T> => {
    const iterator = iterable[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: (value?: unknown) => {
        stop()
        return iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value: undefined })
      }
    }
  }
})
