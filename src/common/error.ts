export class SeuError extends Error {}

/**
 * The expected failure: cli.ts prints it as `error <message>` and exits 1.
 * Anything else reaching the top level keeps its stack, because an unexpected
 * exception is a bug in seu and the stack is the interesting part.
 */
export function die(message: string): never {
  throw new SeuError(message);
}
