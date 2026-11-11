import type { ReactNode } from 'react';
import { type Fleet, fmt, type Summary } from '../stats.ts';

/** Digits that roll to their new value; other characters are drawn as they are. */
function Odometer({ text }: { text: string }) {
  return (
    <span className="odo" role="img" aria-label={text}>
      {[...text].map((ch, i) => {
        const key = text.length - i; // keyed from the right so the units digit stays the same element
        return /\d/.test(ch) ? (
          <span key={key} className="odo-digit">
            <span className="odo-reel" style={{ transform: `translateY(-${Number(ch) * 10}%)` }}>
              {'0123456789'.split('').map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={key} className="odo-sep">
            {ch}
          </span>
        );
      })}
    </span>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(30 - (v / max) * 28).toFixed(2)}`)
    .join(' ');
  return (
    <svg className="hero-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,30 ${pts} 100,30`} className="hero-spark-fill" />
      <polyline points={pts} className="hero-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

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

export function Kpis(props: { s: Summary; f: Fleet; pollMs: number; tps: number[]; av: boolean }) {
  const { s, f, pollMs, tps, av } = props;
  // avmonitor times votes on the gossip network; polling can only see when a block is served
  const propSub = !s.p90
    ? 'measuring…'
    : av
      ? `soft +${fmt.int(s.softMs)} · cert +${fmt.int(s.certMs)} ms`
      : `p90 ${fmt.int(s.p90)} ms · ±${pollMs} ms`;
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
      <div className="hero">
        <div className="hero-main">
          <span className="kpi-label">TRANSACTIONS PER SECOND</span>
          <Odometer text={fmt.num(s.tps, 1)} />
          <span className="kpi-sub">
            peak {fmt.num(s.tpsPeak, 1)} in {fmt.int(s.spanMin)} min · {fmt.int(s.txnsWindow)} transactions
          </span>
        </div>
        <Spark values={tps.slice(-90)} />
      </div>
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
        label={av ? 'PROPOSAL SPREAD' : 'PROPAGATION'}
        value={s.p50 ? fmt.int(s.p50) : '—'}
        unit="ms"
        sub={propSub}
      />
      <Tile label="BLOCK SIZE" value={fmt.kb(s.bytes)} unit="KB" sub={`${fmt.int(s.votes)} votes per cert`} />
      <Tile label="PAYOUT" value={fmt.num(s.payout, 2)} unit="ALGO" sub="per block, last 20" />
      <Tile label="IPV6" value={f.v6Ok} unit={`/ ${f.v6}`} sub="dual-stack answering" />
    </div>
  );
}
