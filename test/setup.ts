import { Logger } from '@nestjs/common';

// Nest's logger is noisy in a test run and its output interleaves with the
// reporter. Anything a test needs to assert on is exposed through state or
// return values, never through the log.
Logger.overrideLogger(false);
