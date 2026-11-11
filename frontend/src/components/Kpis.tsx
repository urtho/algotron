import type { ReactNode } from 'react';
import { type Fleet, fmt, type Summary } from '../stats.ts';

function Tile(props: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className={`kpi${props.tone ? ` kpi--${props.tone}` : ''}`}>
      <span className="kpi-label">{props.label}</span>
      <span className="kpi-value">
        {props.value}
        {props.unit && <span className="kpi-unit">{props.unit}</span>}
      </span>
      <span className="kpi-sub">{props.sub ?? ' '}</span>
    </div>
  );
}

export function Kpis({ s, f, pollMs }: { s: Summary; f: Fleet; pollMs: number }) {
  const relayTone =
    f.relays === 0
      ? undefined
      : f.relaysOk === f.relays
        ? 'ok'
        : f.relaysOk / f.relays > 0.8
          ? 'warn'
          : 'bad';
  const archTone = f.archivers === 0 ? undefined : f.archiversOk === f.archivers ? 'ok' : 'warn';
  return (
    <div className="kpis">
      <Tile
        label="TPS"
        value={fmt.num(s.tps, 1)}
        sub={`peak ${fmt.num(s.tpsPeak, 1)} in ${fmt.int(s.spanMin)} min`}
      />
      <Tile
        label="BLOCK TIME"
        value={fmt.num(s.blockTime, 2)}
        unit="s"
        sub={`${fmt.int(s.txnsPerBlock)} txns per block`}
      />
      <Tile
        label="RELAYS IN SYNC"
        value={f.relaysOk}
        unit={`/ ${f.relays}`}
        tone={relayTone}
        sub={
          f.offline + f.behind > 0
            ? `${f.offline} no answer · ${f.behind} behind`
            : `${f.countries} countries`
        }
      />
      <Tile
        label="ARCHIVERS IN SYNC"
        value={f.archiversOk}
        unit={`/ ${f.archivers}`}
        tone={archTone}
        sub={`median reply ${fmt.int(f.rtt)} ms`}
      />
      <Tile
        label="PROPAGATION"
        value={s.p50 ? fmt.int(s.p50) : '—'}
        unit="ms"
        sub={s.p90 ? `p90 ${fmt.int(s.p90)} ms · ±${pollMs} ms poll` : 'measuring…'}
      />
      <Tile
        label="BLOCK SIZE"
        value={fmt.kb(s.bytes)}
        unit="KB"
        sub={`${fmt.int(s.votes)} votes per certificate`}
      />
      <Tile label="PROPOSER PAYOUT" value={fmt.num(s.payout, 2)} unit="ALGO" sub="mean of last 20 blocks" />
      <Tile label="IPV6" value={f.v6Ok} unit={`/ ${f.v6}`} sub="dual-stack hosts answering" />
    </div>
  );
}
