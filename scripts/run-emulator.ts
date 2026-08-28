/**
 * Runs the X32 emulator as a standalone process so the API (or a frontend)
 * can be developed with no console on the desk:
 *
 *   npm run emulator            # listens on 127.0.0.1:10023
 *   npm run emulator -- 0.0.0.0 10023
 *
 * Then point the API at it with X32_HOST=127.0.0.1 in .env.
 */
import { X32Emulator } from '../test/emulator/x32-emulator.js';

const [address = '127.0.0.1', port = '10023'] = process.argv.slice(2);

const emulator = new X32Emulator({ address, port: Number(port) });

const bound = await emulator.start();
process.stdout.write(`X32 emulator listening on ${address}:${bound} (udp)\n`);
process.stdout.write(
  '  /info /xinfo /status /node /xremote /subscribe /renew + parameters\n',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void emulator.stop().then(() => process.exit(0));
  });
}
