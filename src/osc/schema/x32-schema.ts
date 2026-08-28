/**
 * What each console parameter *is*: its OSC type, its taper, and how the
 * console prints it in a `/node` dump.
 *
 * Three consumers share this one description, which is the point of having it:
 *  - the `/node` parser turns a display-unit dump back into raw values;
 *  - the emulator formats dumps the same way the console does;
 *  - the mixer layer converts between raw values and API units.
 *
 * The *ordering* of a container's children is the risky part: it comes from
 * the unofficial protocol notes, not from hardware here. Anything that parses
 * a dump must therefore tolerate a mismatch rather than trust it — see
 * `parseNodeDump`, which reports a mismatch instead of guessing.
 */

import { STRIP_COUNTS } from '../addresses/x32-addresses.js';
import { OscArg } from '../codec/osc-types.js';
import {
  CHANNEL_COLORS,
  COMP_RATIOS,
  LinearTaper,
  MIN_FADER_DB,
  TAPERS,
  clamp,
  levelDbToFloat,
  levelFloatToDb,
  logFromUnit,
  logToUnit,
  linearFromUnit,
  linearToUnit,
  round,
} from '../units/x32-units.js';

export type ParamKind =
  /** 0..1 fader taper, expressed in dB. */
  | 'level'
  /** Linear taper between two bounds. */
  | 'linear'
  /** Logarithmic taper between two bounds. */
  | 'log'
  /** int32 0/1, printed ON/OFF. */
  | 'bool'
  /** int32 index into a token list. */
  | 'enum'
  /** int32 index into COMP_RATIOS. */
  | 'ratio'
  /** Free int32. */
  | 'int'
  /** OSC string. */
  | 'string';

export interface ParamDef {
  /** Last address segment, e.g. `fader`. */
  readonly name: string;
  readonly kind: ParamKind;
  readonly osc: 'f' | 'i' | 's';
  readonly taper?: LinearTaper;
  readonly values?: readonly string[];
  readonly unit?: 'dB' | 'Hz' | 'ms' | '%' | 'Q';
  readonly decimals?: number;
}

/** Value as the API and the frontend see it. */
export type HumanValue = number | string | boolean;

const p = {
  level: (name: string): ParamDef => ({
    name,
    kind: 'level',
    osc: 'f',
    unit: 'dB',
    decimals: 1,
  }),
  bool: (name: string): ParamDef => ({ name, kind: 'bool', osc: 'i' }),
  int: (name: string): ParamDef => ({ name, kind: 'int', osc: 'i' }),
  string: (name: string): ParamDef => ({ name, kind: 'string', osc: 's' }),
  enum: (name: string, values: readonly string[]): ParamDef => ({
    name,
    kind: 'enum',
    osc: 'i',
    values,
  }),
  linear: (
    name: string,
    taper: LinearTaper,
    unit: ParamDef['unit'],
    decimals = 1,
  ): ParamDef => ({ name, kind: 'linear', osc: 'f', taper, unit, decimals }),
  log: (
    name: string,
    taper: LinearTaper,
    unit: ParamDef['unit'],
    decimals = 1,
  ): ParamDef => ({
    name,
    kind: 'log',
    osc: 'f',
    taper,
    unit,
    decimals,
  }),
  ratio: (name: string): ParamDef => ({ name, kind: 'ratio', osc: 'i' }),
} as const;

/* ------------------------------- enum tokens ------------------------------ */

export const GATE_MODES = ['GATE', 'EXP2', 'EXP3', 'EXP4', 'DUCK'] as const;
export const DYN_MODES = ['COMP', 'EXP'] as const;
export const DYN_DETECTORS = ['PEAK', 'RMS'] as const;
export const DYN_ENVELOPES = ['LIN', 'LOG'] as const;
export const DYN_POSITIONS = ['PRE', 'POST'] as const;
export const EQ_TYPES = ['LCut', 'LShv', 'PEQ', 'VEQ', 'HShv', 'HCut'] as const;
export const KEY_SOURCES = ['SELF'] as const;

/** Trim on the channel strip, -18 .. +18 dB. */
const TRIM_TAPER: LinearTaper = { min: -18, max: 18 };

/* -------------------------------- containers ------------------------------ */

export interface ContainerDef {
  /** Children in the order the console prints them in a `/node` dump. */
  readonly children: readonly ParamDef[];
}

const CONFIG_WITH_SOURCE: ContainerDef = {
  children: [
    p.string('name'),
    p.int('icon'),
    p.enum('color', CHANNEL_COLORS),
    p.int('source'),
  ],
};

const CONFIG_PLAIN: ContainerDef = {
  children: [p.string('name'), p.int('icon'), p.enum('color', CHANNEL_COLORS)],
};

const MIX: ContainerDef = {
  children: [
    p.bool('on'),
    p.level('fader'),
    p.bool('st'),
    p.linear('pan', TAPERS.pan, '%', 0),
    p.bool('mono'),
    p.level('mlevel'),
  ],
};

const BUS_SEND: ContainerDef = {
  children: [
    p.bool('on'),
    p.level('level'),
    p.linear('pan', TAPERS.pan, '%', 0),
  ],
};

const PREAMP: ContainerDef = {
  children: [
    p.linear('trim', TRIM_TAPER, 'dB'),
    p.bool('invert'),
    p.bool('hpon'),
    p.log('hpf', TAPERS.lowCutFreq, 'Hz', 0),
  ],
};

const GATE: ContainerDef = {
  children: [
    p.bool('on'),
    p.enum('mode', GATE_MODES),
    p.linear('thr', TAPERS.gateThreshold, 'dB'),
    p.linear('range', TAPERS.gateRange, 'dB'),
    p.linear('attack', TAPERS.attackMs, 'ms', 0),
    p.log('hold', TAPERS.holdMs, 'ms', 2),
    p.log('release', TAPERS.releaseMs, 'ms', 0),
    p.enum('keysrc', KEY_SOURCES),
  ],
};

const DYN: ContainerDef = {
  children: [
    p.bool('on'),
    p.enum('mode', DYN_MODES),
    p.enum('det', DYN_DETECTORS),
    p.enum('env', DYN_ENVELOPES),
    p.linear('thr', TAPERS.compThreshold, 'dB'),
    p.ratio('ratio'),
    p.linear('knee', TAPERS.compKnee, undefined, 1),
    p.linear('mgain', TAPERS.compMakeupGain, 'dB'),
    p.linear('attack', TAPERS.attackMs, 'ms', 0),
    p.log('hold', TAPERS.holdMs, 'ms', 2),
    p.log('release', TAPERS.releaseMs, 'ms', 0),
    p.enum('pos', DYN_POSITIONS),
    p.enum('keysrc', KEY_SOURCES),
    p.linear('mix', TAPERS.compMix, '%', 0),
  ],
};

const EQ: ContainerDef = { children: [p.bool('on')] };

const EQ_BAND: ContainerDef = {
  children: [
    p.enum('type', EQ_TYPES),
    p.log('f', TAPERS.eqFreq, 'Hz', 1),
    p.linear('g', TAPERS.eqGain, 'dB'),
    p.log('q', TAPERS.eqQ, 'Q', 2),
  ],
};

const DCA: ContainerDef = { children: [p.bool('on'), p.level('fader')] };

const HEADAMP: ContainerDef = {
  children: [p.linear('gain', TAPERS.headampGain, 'dB'), p.bool('phantom')],
};

/**
 * Resolves a container address to its definition.
 *
 * Address shapes handled: `/ch|auxin|fxrtn|bus|mtx/NN/...`, `/main/st|m/...`,
 * `/dca/N`, `/dca/N/config`, `/headamp/NNN`.
 */
export function containerFor(address: string): ContainerDef | undefined {
  if (/^\/headamp\/\d{3}$/.test(address)) return HEADAMP;
  if (/^\/dca\/[1-8]$/.test(address)) return DCA;
  if (/^\/dca\/[1-8]\/config$/.test(address)) return CONFIG_PLAIN;

  const strip = /^\/(ch|auxin|fxrtn|bus|mtx)\/(\d{2})(\/.*)?$/.exec(address);
  const main = /^\/main\/(st|m)(\/.*)?$/.exec(address);
  if (!strip && !main) return undefined;

  const kind = strip ? strip[1] : 'main';
  if (strip) {
    // The index must actually exist on the console: /ch/33 is not a channel.
    const index = Number(strip[2]);
    const count = STRIP_COUNTS[kind as keyof typeof STRIP_COUNTS];
    if (!(index >= 1 && index <= count)) return undefined;
  }
  const rest = (strip ? strip[3] : main?.[2]) ?? '';

  switch (true) {
    case rest === '/config':
      return kind === 'ch' || kind === 'auxin'
        ? CONFIG_WITH_SOURCE
        : CONFIG_PLAIN;
    case rest === '/mix':
      return MIX;
    case /^\/mix\/\d{2}$/.test(rest): {
      const bus = Number(rest.slice(5));
      return bus >= 1 && bus <= STRIP_COUNTS.bus ? BUS_SEND : undefined;
    }
    case rest === '/preamp':
      return PREAMP;
    case rest === '/gate':
      return GATE;
    case rest === '/dyn':
      return DYN;
    case rest === '/eq':
      return EQ;
    case /^\/eq\/[1-6]$/.test(rest):
      return EQ_BAND;
    default:
      return undefined;
  }
}

/** Definition of a single parameter address, e.g. `/ch/01/mix/fader`. */
export function paramFor(address: string): ParamDef | undefined {
  const cut = address.lastIndexOf('/');
  if (cut <= 0) return undefined;
  const container = containerFor(address.slice(0, cut));
  const name = address.slice(cut + 1);
  return container?.children.find((child) => child.name === name);
}

/* ---------------------------- value conversion ---------------------------- */

/** Raw OSC value -> the value the API exposes (dB, Hz, ms, ON/OFF, name). */
export function toHuman(def: ParamDef, arg: OscArg): HumanValue {
  const raw = arg.type === 'i' || arg.type === 'f' ? arg.value : 0;
  switch (def.kind) {
    case 'string':
      return arg.type === 's' ? arg.value : '';
    case 'bool':
      return raw >= 1;
    case 'enum':
      return (
        def.values?.[clamp(Math.round(raw), 0, (def.values.length ?? 1) - 1)] ??
        String(raw)
      );
    case 'ratio':
      return COMP_RATIOS[clamp(Math.round(raw), 0, COMP_RATIOS.length - 1)];
    case 'int':
      return Math.round(raw);
    case 'level':
      return round(levelFloatToDb(raw), def.decimals ?? 1);
    case 'linear':
      return round(
        linearFromUnit(def.taper ?? { min: 0, max: 1 }, raw),
        def.decimals ?? 1,
      );
    case 'log':
      return round(
        logFromUnit(def.taper ?? { min: 1, max: 2 }, raw),
        def.decimals ?? 1,
      );
  }
}

/** API value -> raw OSC argument. */
export function fromHuman(def: ParamDef, value: HumanValue): OscArg {
  switch (def.kind) {
    case 'string':
      return { type: 's', value: String(value) };
    case 'bool':
      return {
        type: 'i',
        value: value === true || value === 1 || value === 'ON' ? 1 : 0,
      };
    case 'enum': {
      const index = def.values?.indexOf(String(value)) ?? -1;
      return { type: 'i', value: index >= 0 ? index : Number(value) || 0 };
    }
    case 'ratio': {
      const target = Number(value);
      let best = 0;
      COMP_RATIOS.forEach((candidate, index) => {
        if (Math.abs(candidate - target) < Math.abs(COMP_RATIOS[best] - target))
          best = index;
      });
      return { type: 'i', value: best };
    }
    case 'int':
      return { type: 'i', value: Math.round(Number(value)) };
    case 'level':
      return { type: 'f', value: levelDbToFloat(Number(value)) };
    case 'linear':
      return {
        type: 'f',
        value: linearToUnit(def.taper ?? { min: 0, max: 1 }, Number(value)),
      };
    case 'log':
      return {
        type: 'f',
        value: logToUnit(def.taper ?? { min: 1, max: 2 }, Number(value)),
      };
  }
}

/* --------------------------- `/node` display form ------------------------- */

/** Formats one value the way the console prints it inside a `/node` dump. */
export function formatNodeToken(def: ParamDef, arg: OscArg): string {
  const human = toHuman(def, arg);
  switch (def.kind) {
    case 'string':
      return `"${String(human)}"`;
    case 'bool':
      return human ? 'ON' : 'OFF';
    case 'enum':
      return String(human);
    case 'ratio':
      return String(human);
    case 'int':
      return String(human);
    case 'level':
      return Number(human) <= MIN_FADER_DB
        ? '-oo'
        : Number(human).toFixed(def.decimals ?? 1);
    default: {
      const decimals = def.decimals ?? 1;
      const text = Number(human).toFixed(decimals);
      // The console prints signed dB values with an explicit plus.
      return def.unit === 'dB' && Number(human) >= 0 ? `+${text}` : text;
    }
  }
}

/**
 * Parses one printed token back into a raw OSC argument.
 * Accepts the console's `1k00` / `12k5` frequency shorthand as well as plain
 * numbers, and `-oo` for a closed fader.
 */
export function parseNodeToken(def: ParamDef, token: string): OscArg {
  const text = token.trim();
  switch (def.kind) {
    case 'string':
      return { type: 's', value: text.replace(/^"|"$/g, '') };
    case 'bool':
      return { type: 'i', value: text === 'ON' || text === '1' ? 1 : 0 };
    case 'enum': {
      const index = def.values?.indexOf(text) ?? -1;
      if (index >= 0) return { type: 'i', value: index };
      const numeric = Number(text);
      return {
        type: 'i',
        value: Number.isFinite(numeric) ? Math.round(numeric) : 0,
      };
    }
    case 'ratio':
      return fromHuman(def, parseNumericToken(text));
    case 'int':
      return { type: 'i', value: Math.round(parseNumericToken(text)) };
    case 'level':
      return {
        type: 'f',
        value: text === '-oo' ? 0 : levelDbToFloat(parseNumericToken(text)),
      };
    default:
      return fromHuman(def, parseNumericToken(text));
  }
}

/** `1k00` -> 1000, `12k5` -> 12500, `-6.0` -> -6, `-oo` -> -90. */
export function parseNumericToken(token: string): number {
  const text = token.trim();
  if (text === '-oo' || text === '-inf') return MIN_FADER_DB;
  const kilo = /^([+-]?\d+)k(\d*)$/.exec(text);
  if (kilo) {
    const fraction = kilo[2] === '' ? 0 : Number(`0.${kilo[2]}`);
    return (Number(kilo[1]) + fraction) * 1000;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Splits a `/node` line into its address and printed values.
 * Values are whitespace-separated with quoted strings kept intact:
 *   `/ch/01/config "Kick In" 1 GN 1`
 */
export function splitNodeLine(
  line: string,
): { address: string; tokens: string[] } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return undefined;

  const tokens = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const [address, ...rest] = tokens;
  if (address === undefined) return undefined;
  return { address, tokens: rest };
}
