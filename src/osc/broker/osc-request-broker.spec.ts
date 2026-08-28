import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '../codec/osc-codec.js';
import { OscMessage, oscFloat, oscString } from '../codec/osc-types.js';
import { OscPriority } from '../rate-limit/osc-rate-limiter.js';
import {
  OscRequestAbortedError,
  OscRequestBroker,
  OscRequestTimeoutError,
} from './osc-request-broker.js';

function harness(options: { timeoutMs?: number; failSend?: boolean } = {}): {
  broker: OscRequestBroker;
  sent: { message: OscMessage; priority: OscPriority }[];
} {
  const sent: { message: OscMessage; priority: OscPriority }[] = [];
  const broker = new OscRequestBroker(
    (msg, priority) => {
      if (options.failSend) return Promise.reject(new Error('socket closed'));
      sent.push({ message: msg, priority });
      return Promise.resolve();
    },
    { timeoutMs: options.timeoutMs ?? 1000, label: 'test' },
  );
  return { broker, sent };
}

describe('OscRequestBroker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a query with the reply that arrives on the same address', async () => {
    const { broker, sent } = harness();
    const pending = broker.request(message('/ch/01/mix/fader'));

    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0].message.address).toBe('/ch/01/mix/fader');
    expect(sent[0].priority).toBe(OscPriority.Command);

    const reply = message('/ch/01/mix/fader', oscFloat(0.6));
    expect(broker.handleMessage(reply)).toBe(true);
    await expect(pending).resolves.toEqual(reply);
    expect(broker.pendingCount).toBe(0);
  });

  it('matches a /node reply, which the console sends on the bare address "node"', async () => {
    const { broker } = harness();
    const pending = broker.request(message('/node', oscString('ch/01/mix')), {
      replyAddress: 'node',
    });
    await vi.advanceTimersByTimeAsync(0);

    const reply: OscMessage = {
      address: 'node',
      args: [oscString('/ch/01/mix ON -6.0')],
    };
    expect(broker.handleMessage(reply)).toBe(true);
    await expect(pending).resolves.toEqual(reply);
  });

  it('treats "/node" and "node" as the same reply address', async () => {
    const { broker } = harness();
    const pending = broker.request(message('/node', oscString('ch/01')), {
      replyAddress: '/node',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      broker.handleMessage({ address: 'node', args: [oscString('/ch/01')] }),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({ address: 'node' });
  });

  it('serves concurrent requests on one address first-in first-out', async () => {
    const { broker } = harness();
    const first = broker.request(message('/ch/01/mix/fader'));
    const second = broker.request(message('/ch/01/mix/fader'));
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.pendingCount).toBe(2);

    broker.handleMessage(message('/ch/01/mix/fader', oscFloat(0.1)));
    broker.handleMessage(message('/ch/01/mix/fader', oscFloat(0.2)));

    await expect(first).resolves.toMatchObject({ args: [{ value: 0.1 }] });
    await expect(second).resolves.toMatchObject({ args: [{ value: 0.2 }] });
  });

  it('ignores a message nobody is waiting for', () => {
    const { broker } = harness();
    expect(broker.handleMessage(message('/ch/02/mix/on'))).toBe(false);
  });

  it('times out when the console never answers', async () => {
    const { broker } = harness({ timeoutMs: 250 });
    const pending = broker.request(message('/ch/01/mix/fader'));
    const assertion = expect(pending).rejects.toBeInstanceOf(
      OscRequestTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(broker.pendingCount).toBe(0);
  });

  it('honours a per-request timeout override', async () => {
    const { broker } = harness({ timeoutMs: 10_000 });
    const assertion = expect(
      broker.request(message('/ch/01/mix/fader'), { timeoutMs: 100 }),
    ).rejects.toThrow(/within 100ms/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('does not resolve a request with a reply that arrives after the timeout', async () => {
    const { broker } = harness({ timeoutMs: 100 });
    const assertion = expect(
      broker.request(message('/ch/01/mix/fader')),
    ).rejects.toThrow(OscRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(
      broker.handleMessage(message('/ch/01/mix/fader', oscFloat(0.6))),
    ).toBe(false);
  });

  it('fails the request when the send itself fails', async () => {
    const { broker } = harness({ failSend: true });
    await expect(broker.request(message('/ch/01/mix/fader'))).rejects.toThrow(
      'socket closed',
    );
    expect(broker.pendingCount).toBe(0);
  });

  it('aborts everything in flight when the link drops', async () => {
    const { broker } = harness({ timeoutMs: 10_000 });
    const first = expect(broker.request(message('/a'))).rejects.toBeInstanceOf(
      OscRequestAbortedError,
    );
    const second = expect(broker.request(message('/b'))).rejects.toBeInstanceOf(
      OscRequestAbortedError,
    );
    await vi.advanceTimersByTimeAsync(0);

    broker.abortAll();
    await Promise.all([first, second]);
    expect(broker.pendingCount).toBe(0);
  });

  it('sends polling queries at polling priority when asked', async () => {
    const { broker, sent } = harness();
    const pending = expect(
      broker.request(message('/node', oscString('ch/01')), {
        replyAddress: 'node',
        priority: OscPriority.Polling,
      }),
    ).rejects.toBeInstanceOf(OscRequestAbortedError);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0].priority).toBe(OscPriority.Polling);
    broker.abortAll();
    await pending;
  });
});
