import type { Builder, Creator } from '../lib/explore';
import { shorten } from '../lib/format';

/**
 * Who made an agent and what it is built with, as two separate lines: "Created by" names the on-chain owner, and "Built
 * with AgentEnact" shows for agents built here (hosted or library), never for external ones.
 */
export function makerLines(a: { builder: Builder; creator?: Creator | undefined }): { by: { name: string; title: string; address: boolean } | null; built: boolean } {
  const c = a.creator;
  const by = c?.kind === 'owner' ? { name: shorten(c.address, 4, 4), title: `Owner on chain: ${c.address}`, address: true } : null;
  return { by, built: a.builder !== 'external' };
}

/** The two lines. `className` sets the block, each line is a span on its own row; the address is monospace. */
export function Maker({ builder, creator, className = 'mkr' }: { builder: Builder; creator?: Creator | undefined; className?: string }) {
  const { by, built } = makerLines({ builder, creator });
  if (!by && !built) return null;
  return (
    <span className={className}>
      {by ? (
        <span className="mkr-by" title={by.title}>
          Created by <span className={by.address ? 'mkr-addr' : 'mkr-name'}>{by.name}</span>
        </span>
      ) : null}
      {built ? <span className="mkr-built">Built with AgentEnact</span> : null}
    </span>
  );
}
