import { describe, expect, it } from 'vitest';
import { levelDbToFloat } from '../osc/units/x32-units.js';
import { FaderMove, planFaderRamp, positionLerp } from './fader-ramp.js';

const move = (address: string, fromDb: number, toDb: number): FaderMove => ({
  address,
  fromDb,
  toDb,
});

describe('fader ramping', () => {
  describe('planning', () => {
    it('walks a single fader to its target in steps', () => {
      const plan = planFaderRamp([move('/ch/01/mix/fader', -20, 0)], {
        durationMs: 400,
        maxMessagesPerSecond: 50,
      });

      expect(plan.stepsPerFader).toBeGreaterThanOrEqual(2);
      expect(plan.steps).toHaveLength(plan.stepsPerFader);
      expect(plan.steps.at(-1)).toMatchObject({ db: 0, final: true });
      expect(plan.steps.at(-1)?.atMs).toBe(400);
    });

    it('ends exactly on the target, never near it', () => {
      for (const target of [0, -6, -12.5, -90, 10]) {
        const plan = planFaderRamp([move('/ch/01/mix/fader', -30, target)], {
          durationMs: 400,
          maxMessagesPerSecond: 50,
        });
        expect(plan.steps.at(-1)?.db).toBe(target);
      }
    });

    it('moves monotonically towards the target', () => {
      const plan = planFaderRamp([move('/ch/01/mix/fader', -60, 0)], {
        durationMs: 800,
        maxMessagesPerSecond: 50,
      });
      let previous = -60;
      for (const step of plan.steps) {
        expect(step.db).toBeGreaterThanOrEqual(previous);
        previous = step.db;
      }
    });

    it('sends a change too small to click as one message', () => {
      const plan = planFaderRamp([move('/ch/01/mix/fader', -6, -6.4)], {
        durationMs: 400,
        maxMessagesPerSecond: 50,
      });
      expect(plan.steps).toHaveLength(0);
      expect(plan.immediate).toHaveLength(1);
    });

    it('fits the whole ramp inside the wire budget', () => {
      // 20 faders, 400ms, 50 msg/s = 20 messages of budget in total.
      const moves = Array.from({ length: 20 }, (_, i) =>
        move(`/ch/${String(i + 1).padStart(2, '0')}/mix/fader`, -90, -6),
      );
      const plan = planFaderRamp(moves, {
        durationMs: 400,
        maxMessagesPerSecond: 50,
      });

      const budget = (400 / 1000) * 50;
      expect(plan.steps.length).toBeLessThanOrEqual(
        Math.max(budget, moves.length * 2),
      );
      // Even when starved, a fader gets at least a midpoint and a target: two
      // steps is a move, one step is the jump we are avoiding.
      expect(plan.stepsPerFader).toBeGreaterThanOrEqual(2);
      expect(plan.budgetLimited).toBe(true);
    });

    it('spends its budget on smoothness when only one fader moves', () => {
      const plan = planFaderRamp([move('/ch/01/mix/fader', -90, 0)], {
        durationMs: 800,
        maxMessagesPerSecond: 50,
      });
      expect(plan.stepsPerFader).toBeGreaterThanOrEqual(8);
      expect(plan.budgetLimited).toBe(false);
    });

    it('never exceeds the step ceiling', () => {
      const plan = planFaderRamp([move('/ch/01/mix/fader', -90, 0)], {
        durationMs: 5000,
        maxMessagesPerSecond: 200,
        maxStepsPerFader: 6,
      });
      expect(plan.stepsPerFader).toBe(6);
    });

    it('moves every fader together rather than one after another', () => {
      const moves = [
        move('/ch/01/mix/fader', -20, 0),
        move('/ch/02/mix/fader', 0, -20),
      ];
      const plan = planFaderRamp(moves, {
        durationMs: 400,
        maxMessagesPerSecond: 100,
      });

      const times = [...new Set(plan.steps.map((step) => step.atMs))];
      for (const time of times) {
        const atThisTime = plan.steps.filter((step) => step.atMs === time);
        expect(atThisTime).toHaveLength(2);
      }
    });

    it('plans nothing when nothing moves', () => {
      const plan = planFaderRamp([], {
        durationMs: 400,
        maxMessagesPerSecond: 50,
      });
      expect(plan.steps).toHaveLength(0);
      expect(plan.immediate).toHaveLength(0);
    });
  });

  describe('interpolation', () => {
    it('travels in fader position, which is what a hand on the fader does', () => {
      // Half way through a -90 -> 0 dB move, the fader is half way up its
      // travel — not at -45 dB, which would be almost inaudible.
      const half = positionLerp(-90, 0, 0.5);
      expect(levelDbToFloat(half)).toBeCloseTo(levelDbToFloat(0) / 2, 2);
      expect(half).toBeLessThan(-6);
      expect(half).toBeGreaterThan(-45);
    });

    it('returns the endpoints exactly', () => {
      expect(positionLerp(-20, -6, 0)).toBe(-20);
      expect(positionLerp(-20, -6, 1)).toBe(-6);
    });

    it('clamps progress outside 0..1', () => {
      expect(positionLerp(-20, -6, -1)).toBe(-20);
      expect(positionLerp(-20, -6, 5)).toBe(-6);
    });

    it('works downwards as well as upwards', () => {
      const quarter = positionLerp(0, -60, 0.25);
      expect(quarter).toBeLessThan(0);
      expect(quarter).toBeGreaterThan(-60);
    });
  });
});
