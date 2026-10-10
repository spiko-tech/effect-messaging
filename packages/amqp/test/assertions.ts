import { expect } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"

// Effect.fn attaches tracing annotations to causes; compare the domain error,
// not incidental runtime metadata on the Exit.
export const expectFailure = <E>(exit: Exit.Exit<unknown, E>, expected: object): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toEqual(expect.objectContaining(expected))
  }
}
