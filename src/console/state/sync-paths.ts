import {
  STRIP_COUNTS,
  allStripRoots,
  headampRoot,
  pad2,
} from '../../osc/addresses/x32-addresses.js';
import { SyncDepth } from '../console.types.js';

/**
 * The `/node` subtree queries that fill the state mirror, ordered so the most
 * useful information arrives first.
 *
 * A full mirror is roughly 1500 queries. At the ~50 msg/s the console tolerates
 * that is close to half a minute of traffic, which is why it is staged: the
 * link is usable after the surface stage (~160 queries, about three seconds)
 * and the rest streams in behind it at polling priority.
 */

const PROCESSING_SUFFIXES = [
  '/preamp',
  '/gate',
  '/dyn',
  '/eq',
  '/eq/1',
  '/eq/2',
  '/eq/3',
  '/eq/4',
];

/** Strips that carry a channel-strip processing chain. */
function processingRoots(): string[] {
  return allStripRoots().filter((root) => !root.startsWith('/dca/'));
}

/** Strips that can send to a bus. */
function sendSourceRoots(): string[] {
  return allStripRoots().filter((root) => /^\/(ch|auxin|fxrtn)\//.test(root));
}

export function surfacePaths(): string[] {
  const paths: string[] = [];
  for (const root of allStripRoots()) {
    if (root.startsWith('/dca/')) {
      paths.push(root, `${root}/config`);
      continue;
    }
    paths.push(`${root}/config`, `${root}/mix`);
  }
  for (let input = 1; input <= STRIP_COUNTS.ch; input += 1) {
    paths.push(headampRoot(input));
  }
  return paths;
}

export function sendPaths(): string[] {
  const paths: string[] = [];
  for (const root of sendSourceRoots()) {
    for (let bus = 1; bus <= STRIP_COUNTS.bus; bus += 1) {
      paths.push(`${root}/mix/${pad2(bus)}`);
    }
  }
  return paths;
}

export function processingPaths(): string[] {
  const paths: string[] = [];
  for (const root of processingRoots()) {
    for (const suffix of PROCESSING_SUFFIXES) paths.push(`${root}${suffix}`);
  }
  return paths;
}

/** Paths for one stage only. */
export function stagePaths(depth: SyncDepth): string[] {
  switch (depth) {
    case 'surface':
      return surfacePaths();
    case 'sends':
      return sendPaths();
    case 'full':
      return processingPaths();
  }
}

/** Every stage up to and including `depth`, in order. */
export function syncStages(
  depth: SyncDepth,
): { depth: SyncDepth; paths: string[] }[] {
  const stages: { depth: SyncDepth; paths: string[] }[] = [
    { depth: 'surface', paths: surfacePaths() },
  ];
  if (depth === 'sends' || depth === 'full')
    stages.push({ depth: 'sends', paths: sendPaths() });
  if (depth === 'full')
    stages.push({ depth: 'full', paths: processingPaths() });
  return stages;
}
