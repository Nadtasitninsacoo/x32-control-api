import { Logger } from '@nestjs/common';

// Nest's logger is noisy in a test run and its output interleaves with the
// reporter — and several tests deliberately provoke errors (a console that
// stops answering, a parameter the emulator does not know). Anything a test
// needs to assert on is exposed through state or return values, never the log.
Logger.overrideLogger({
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
});
