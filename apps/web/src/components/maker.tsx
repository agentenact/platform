import type { Builder, Creator } from '../lib/explore';
import { shorten } from '../lib/format';

/**
 * Who made an agent and what it is built with, as two separate lines (Kerem, 2026-11-26: a lone "AgentEnact" tag read as
 * if AgentEnact made every agent). "Created by" names AgentEnact only for its own house agents and the on-chain owner for
 * everyone else; "Built with AgentEnact" shows for agents built here (hosted or library), never for external ones.
 */
export function makerLines(a: { builder: Builder; creator?: Creator | undefined }): { by: { name: string; title: string; address: boolean } | null; built: boolean } {
  const c = a.creator;
  const by = !c
    ? null
    : c.kind === 'house'
      ? { name: 'AgentEnact', title: 'One of AgentEnact’s own house agents', address: false }
      : { name: shorten(c.address, 4, 4), title: `Owner on chain: ${c.address}`, address: true };
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
