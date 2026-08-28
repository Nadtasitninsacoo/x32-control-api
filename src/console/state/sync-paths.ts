import {
  STRIP_COUNTS,
  allStripRoots,
  headampRoot,
  pad2,
} from '../../osc/addresses/x32-addresses.js';
import {
  capabilitiesFor,
  familyOf,
} from '../../osc/schema/x32-capabilities.js';
import { SyncDepth } from '../console.types.js';

/**
 * The `/node` subtree queries that fill the state mirror, ordered so the most
 * useful information arrives first.
 *
 * A full mirror is roughly 1500 queries. At the ~50 msg/s the console tolerates
 * that is close to half a minute of traffic, which is why it is staged: the
 * link is usable after the surface stage (~160 queries, about three seconds)
 * and the rest streams in behind it at polling priority.
 *
 * What each strip is asked for comes from its capabilities, so nothing is ever
 * queried on a strip that does not have it — an unanswered query costs a full
 * timeout and buys nothing.
 */

interface Strip {
  readonly root: string;
  readonly capabilities: ReturnType<typeof capabilitiesFor>;
}

function strips(): Strip[] {
  return allStripRoots().flatMap((root) => {
    const family = familyOf(root);
    return family ? [{ root, capabilities: capabilitiesFor(family) }] : [];
  });
}

export function surfacePaths(): string[] {
  const paths: string[] = [];
  for (const { root, capabilities } of strips()) {
    if (capabilities.config) paths.push(`${root}/config`);
    // A DCA's fader and mute live on the root itself, not under /mix.
    paths.push(capabilities.mix ? `${root}/mix` : root);
  }
  for (let input = 1; input <= STRIP_COUNTS.ch; input += 1) {
    paths.push(headampRoot(input));
  }
  return paths;
}

export function sendPaths(): string[] {
  const paths: string[] = [];
  for (const { root, capabilities } of strips()) {
    for (let send = 1; send <= capabilities.sends; send += 1) {
      paths.push(`${root}/mix/${pad2(send)}`);
    }
  }
  return paths;
}

export function processingPaths(): string[] {
  const paths: string[] = [];
  for (const { root, capabilities } of strips()) {
    if (capabilities.preamp) paths.push(`${root}/preamp`);
    if (capabilities.gate) paths.push(`${root}/gate`);
    if (capabilities.dyn) paths.push(`${root}/dyn`);
    if (capabilities.eqBands > 0) {
      paths.push(`${root}/eq`);
      for (let band = 1; band <= capabilities.eqBands; band += 1) {
        paths.push(`${root}/eq/${band}`);
      }
    }
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
  if (depth === 'sends' || depth === 'full') {
    stages.push({ depth: 'sends', paths: sendPaths() });
  }
  if (depth === 'full') {
    stages.push({ depth: 'full', paths: processingPaths() });
  }
  return stages;
}
