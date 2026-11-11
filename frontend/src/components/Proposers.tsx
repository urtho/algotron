import { fmt, type ProposerRow } from '../stats.ts';

export function Proposers({
  rows,
  explorer,
  blocks,
}: {
  rows: ProposerRow[];
  explorer: string;
  blocks: number;
}) {
  const max = Math.max(1, ...rows.map((r) => r.blocks));
  return (
    <section className="proposers">
      <header className="chart-head">
        <span className="panel-title">TOP PROPOSERS</span>
        <span className="chart-note">last {blocks} blocks</span>
      </header>
      <div className="proposers-body">
        {rows.map((r) => (
          <a
            key={r.address}
            className="proposer"
            href={`${explorer}/account/${r.address}`}
            target="_blank"
            rel="noreferrer"
          >
            <span className="proposer-addr">{fmt.addr(r.address)}</span>
            <span className="proposer-bar">
              <span style={{ width: `${(r.blocks / max) * 100}%` }} />
            </span>
            <span className="proposer-n">{r.blocks}</span>
            <span className="proposer-share">{fmt.num(r.share * 100, 1)}%</span>
          </a>
        ))}
        {rows.length === 0 && <div className="chart-note">waiting for blocks…</div>}
      </div>
    </section>
  );
}
