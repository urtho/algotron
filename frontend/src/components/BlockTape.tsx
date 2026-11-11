import type { BlockStat } from '../../../shared/types.ts';
import { fmt } from '../stats.ts';

/** The newest blocks as a strip of cells, newest on the right. */
export function BlockTape({
  blocks,
  explorer,
  labels,
}: {
  blocks: BlockStat[];
  explorer: string;
  labels: Record<string, string>;
}) {
  const recent = blocks.slice(-9);
  const max = Math.max(1, ...recent.map((b) => b.txns));
  return (
    <div className="tape">
      {recent.map((b, i) => (
        <a
          key={b.round}
          className={`tape-cell${i === recent.length - 1 ? ' tape-cell--new' : ''}`}
          href={`${explorer}/block/${b.round}`}
          target="_blank"
          rel="noreferrer"
          title={`Proposer ${b.proposer}`}
        >
          <span className="tape-round">#{String(b.round).slice(-4)}</span>
          <span className="tape-txns">{b.txns}</span>
          <span className="tape-bar">
            <span style={{ width: `${(b.txns / max) * 100}%` }} />
          </span>
          <span className="tape-meta">{fmt.kb(b.bytes)} KB</span>
          <span className="tape-meta">
            {b.first ? `▸ ${labels[b.first] ?? '?'}` : fmt.addr(b.proposer).slice(0, 6)}
          </span>
        </a>
      ))}
    </div>
  );
}
