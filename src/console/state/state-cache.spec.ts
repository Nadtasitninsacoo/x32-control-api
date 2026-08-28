import { describe, expect, it, vi } from 'vitest';
import { message } from '../../osc/codec/osc-codec.js';
import {
  oscBlob,
  oscFloat,
  oscInt,
  oscString,
} from '../../osc/codec/osc-types.js';
import { levelDbToFloat } from '../../osc/units/x32-units.js';
import { StateCache, StateChange } from './state-cache.js';

describe('StateCache', () => {
  it('stores a value and reads it back in API units', () => {
    const cache = new StateCache();
    cache.set('/ch/01/mix/fader', [oscFloat(levelDbToFloat(-6))], 'sync');

    expect(cache.getValue('/ch/01/mix/fader')).toBe(-6);
    expect(cache.get('/ch/01/mix/fader')).toEqual([
      { type: 'f', value: levelDbToFloat(-6) },
    ]);
    expect(cache.size).toBe(1);
  });

  it('reports whether a write actually changed anything', () => {
    const cache = new StateCache();
    expect(cache.set('/ch/01/mix/on', [oscInt(1)])).toBe(true);
    expect(cache.set('/ch/01/mix/on', [oscInt(1)])).toBe(false);
    expect(cache.set('/ch/01/mix/on', [oscInt(0)])).toBe(true);
  });

  it('notifies subscribers only on a real change', () => {
    const cache = new StateCache();
    const changes: StateChange[] = [];
    const unsubscribe = cache.subscribe((change) => changes.push(change));

    cache.set('/ch/01/mix/fader', [oscFloat(0.75)], 'feed');
    cache.set('/ch/01/mix/fader', [oscFloat(0.75)], 'feed');
    cache.set('/ch/01/mix/fader', [oscFloat(0.6)], 'feed');

    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      address: '/ch/01/mix/fader',
      value: -6,
      source: 'feed',
    });
    expect(changes[1].previous).toEqual([{ type: 'f', value: 0.75 }]);

    unsubscribe();
    cache.set('/ch/01/mix/fader', [oscFloat(1)], 'feed');
    expect(changes).toHaveLength(2);
  });

  it('compares blobs by content, not by identity', () => {
    const cache = new StateCache();
    cache.set('/x', [oscBlob(Buffer.from([1, 2, 3]))]);
    expect(cache.set('/x', [oscBlob(Buffer.from([1, 2, 3]))])).toBe(false);
    expect(cache.set('/x', [oscBlob(Buffer.from([1, 2, 4]))])).toBe(true);
  });

  describe('applyMessage', () => {
    it('mirrors a parameter update from the feed', () => {
      const cache = new StateCache();
      expect(cache.applyMessage(message('/ch/02/mix/on', oscInt(0)))).toBe(
        true,
      );
      expect(cache.getValue('/ch/02/mix/on')).toBe(false);
    });

    it('ignores meter blobs — those belong to the metering pipeline', () => {
      const cache = new StateCache();
      expect(
        cache.applyMessage(message('/meters/1', oscBlob(Buffer.alloc(8)))),
      ).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('ignores replies that carry no value and non-parameter addresses', () => {
      const cache = new StateCache();
      expect(cache.applyMessage(message('/ch/01/mix/fader'))).toBe(false);
      expect(
        cache.applyMessage({
          address: 'node',
          args: [oscString('/ch/01/mix ON')],
        }),
      ).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('records when the feed was last heard from', () => {
      const clock = vi.fn(() => 1_000);
      const cache = new StateCache(clock);
      expect(cache.lastFeedAt).toBeUndefined();
      cache.applyMessage(message('/ch/01/mix/on', oscInt(1)));
      expect(cache.lastFeedAt).toBe(1_000);
    });
  });

  describe('applyNodeDump', () => {
    it('fills a whole container from one dump line', () => {
      const cache = new StateCache();
      const result = cache.applyNodeDump('/ch/01/mix ON -6.0 ON +0 OFF -oo');

      expect(result.applied).toBe(6);
      expect(result.unparsed).toEqual([]);
      expect(cache.getValue('/ch/01/mix/fader')).toBe(-6);
      expect(cache.getValue('/ch/01/mix/on')).toBe(true);
    });

    it('hands back containers it refused to decode', () => {
      const cache = new StateCache();
      const result = cache.applyNodeDump(
        '/ch/01/mix ON -6.0 ON +0 OFF -oo EXTRA',
      );

      expect(result.applied).toBe(0);
      expect(result.unparsed).toEqual(['/ch/01/mix']);
      expect(cache.size).toBe(0);
    });
  });

  it('snapshots a subtree in API units', () => {
    const cache = new StateCache();
    cache.applyNodeDump('/ch/01/config "Kick In" 1 GN 1');
    cache.applyNodeDump('/ch/02/config "Snare" 1 RD 2');

    expect(cache.snapshot('/ch/01/')).toEqual({
      '/ch/01/config/name': 'Kick In',
      '/ch/01/config/icon': 1,
      '/ch/01/config/color': 'GN',
      '/ch/01/config/source': 1,
    });
    expect(cache.addresses('/ch/02/')).toEqual([
      '/ch/02/config/color',
      '/ch/02/config/icon',
      '/ch/02/config/name',
      '/ch/02/config/source',
    ]);
  });

  it('clears everything, including the sync and feed timestamps', () => {
    const cache = new StateCache();
    cache.set('/ch/01/mix/on', [oscInt(1)], 'feed');
    cache.markSynced();
    expect(cache.lastSyncAt).toBeDefined();

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.lastSyncAt).toBeUndefined();
    expect(cache.lastFeedAt).toBeUndefined();
  });
});
