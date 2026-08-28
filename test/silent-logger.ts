import { LoggerService } from '@nestjs/common';

/**
 * `Test.createTestingModule()` installs its own logger, which overrides the
 * global one from the setup file — so testing modules get this passed
 * explicitly via `.setLogger()`. Several tests provoke errors on purpose (a
 * console that stops answering, an unreachable host) and their stack traces
 * are noise, not signal.
 */
export const silentLogger: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
};
