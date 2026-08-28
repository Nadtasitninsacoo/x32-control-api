import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryPresetStore } from './memory-preset.store.js';

describe('preset storage (in-memory)', () => {
  let store: MemoryPresetStore;

  beforeEach(() => {
    store = new MemoryPresetStore();
  });

  describe('venues and bands', () => {
    it('creates and reads a venue', async () => {
      const venue = await store.createVenue({
        name: 'The Old Hall',
        roomSize: '800 cap',
        notes: 'Rings at 160 Hz',
      });

      expect(venue.id).toBeTruthy();
      expect(await store.findVenue(venue.id)).toMatchObject({
        name: 'The Old Hall',
      });
      expect(await store.listVenues()).toHaveLength(1);
    });

    it('refuses two venues with the same name', async () => {
      await store.createVenue({ name: 'The Old Hall' });
      await expect(store.createVenue({ name: 'The Old Hall' })).rejects.toThrow(
        /already exists/,
      );
    });

    it('keeps an input list with a band', async () => {
      const band = await store.createBand({
        name: 'The Loud Ones',
        inputList: [
          {
            input: 1,
            name: 'Kick In',
            color: 'GN',
            gainDb: 24,
            phantom: false,
          },
          { input: 2, name: 'Snare', gainDb: 30 },
        ],
      });

      const found = await store.findBand(band.id);
      expect(found?.inputList).toHaveLength(2);
      expect(found?.inputList?.[0]).toMatchObject({
        input: 1,
        name: 'Kick In',
        gainDb: 24,
      });
    });

    it('leaves presets standing when their venue is deleted', async () => {
      const venue = await store.createVenue({ name: 'The Old Hall' });
      const preset = await store.createPreset({
        name: 'Rock Night',
        venueId: venue.id,
        values: { '/ch/01/mix/fader': -6 },
      });

      await store.deleteVenue(venue.id);

      // The mix is still there; it just no longer belongs to a venue.
      const after = await store.findPreset(preset.id);
      expect(after).toBeDefined();
      expect(after?.venueId).toBeNull();
      expect((await store.findVersion(preset.id, 1))?.values).toEqual({
        '/ch/01/mix/fader': -6,
      });
    });
  });

  describe('presets and versions', () => {
    it('creates a preset with its first version', async () => {
      const preset = await store.createPreset({
        name: 'Rock Night',
        values: { '/ch/01/mix/fader': -6 },
        note: 'after soundcheck',
        createdBy: 'sam',
      });

      expect(preset.version).toBe(1);
      const versions = await store.listVersions(preset.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        version: 1,
        note: 'after soundcheck',
        createdBy: 'sam',
      });
    });

    it('allows the same preset name under different venues', async () => {
      const a = await store.createVenue({ name: 'Hall A' });
      const b = await store.createVenue({ name: 'Hall B' });
      await store.createPreset({
        name: 'House Mix',
        venueId: a.id,
        values: {},
      });
      await expect(
        store.createPreset({ name: 'House Mix', venueId: b.id, values: {} }),
      ).resolves.toBeDefined();
    });

    it('refuses the same preset name for the same venue and band', async () => {
      const venue = await store.createVenue({ name: 'Hall A' });
      await store.createPreset({
        name: 'House Mix',
        venueId: venue.id,
        values: {},
      });
      await expect(
        store.createPreset({
          name: 'House Mix',
          venueId: venue.id,
          values: {},
        }),
      ).rejects.toThrow(/already exists/);
    });

    it('adds versions and moves the head forward', async () => {
      const preset = await store.createPreset({ name: 'p', values: { a: 1 } });
      await store.addVersion(preset.id, { a: 2 }, 'louder');
      const third = await store.addVersion(preset.id, { a: 3 });

      expect(third.version).toBe(3);
      expect((await store.findPreset(preset.id))?.version).toBe(3);
      expect(
        (await store.listVersions(preset.id)).map((v) => v.version),
      ).toEqual([3, 2, 1]);
    });

    it('never rewrites an old version', async () => {
      const preset = await store.createPreset({ name: 'p', values: { a: 1 } });
      await store.addVersion(preset.id, { a: 2 });

      expect((await store.findVersion(preset.id, 1))?.values).toEqual({ a: 1 });
      expect((await store.findVersion(preset.id, 2))?.values).toEqual({ a: 2 });
    });

    it('rolls the head back without losing anything', async () => {
      const preset = await store.createPreset({ name: 'p', values: { a: 1 } });
      await store.addVersion(preset.id, { a: 2 });

      const rolled = await store.setCurrentVersion(preset.id, 1);
      expect(rolled.version).toBe(1);
      expect(await store.listVersions(preset.id)).toHaveLength(2);
    });

    it('numbers a version saved after a rollback above everything that existed', async () => {
      // Otherwise saving after a rollback would overwrite the very history
      // that made the rollback possible.
      const preset = await store.createPreset({ name: 'p', values: { a: 1 } });
      await store.addVersion(preset.id, { a: 2 });
      await store.setCurrentVersion(preset.id, 1);

      const next = await store.addVersion(preset.id, { a: 3 });
      expect(next.version).toBe(3);
      expect((await store.findVersion(preset.id, 2))?.values).toEqual({ a: 2 });
    });

    it('refuses to roll back to a version that never existed', async () => {
      const preset = await store.createPreset({ name: 'p', values: {} });
      await expect(store.setCurrentVersion(preset.id, 7)).rejects.toThrow(
        /no version 7/,
      );
    });

    it('filters presets by venue and band', async () => {
      const venue = await store.createVenue({ name: 'Hall' });
      const band = await store.createBand({ name: 'Band' });
      await store.createPreset({ name: 'a', venueId: venue.id, values: {} });
      await store.createPreset({ name: 'b', bandId: band.id, values: {} });
      await store.createPreset({ name: 'c', values: {} });

      expect(await store.listPresets({ venueId: venue.id })).toHaveLength(1);
      expect(await store.listPresets({ bandId: band.id })).toHaveLength(1);
      expect(await store.listPresets()).toHaveLength(3);
    });

    it('takes a preset and its history away together', async () => {
      const preset = await store.createPreset({ name: 'p', values: {} });
      await store.deletePreset(preset.id);

      expect(await store.findPreset(preset.id)).toBeUndefined();
      expect(await store.listVersions(preset.id)).toHaveLength(0);
    });
  });
});
