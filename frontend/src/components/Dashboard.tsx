import { useMemo } from 'react';
import type { AppState } from '../state.ts';
import {
  blockTimeSeries,
  fleet,
  fmt,
  summarize,
  TX_KINDS,
  TX_LABELS,
  topProposers,
  tpsSeries,
  txParts,
} from '../stats.ts';
import { useWallMode } from '../wall.ts';
import { BlockRiver } from './BlockRiver.tsx';
import { ChartPanel, LineChart, StackChart } from './Chart.tsx';
import { Globe } from './Globe.tsx';
import { HexWall } from './HexWall.tsx';
import { Kpis } from './Kpis.tsx';
import { Moments } from './Moments.tsx';
import { ProposerRing } from './ProposerRing.tsx';
import { RoundClock } from './RoundClock.tsx';
import { TerminalPane } from './TerminalPane.tsx';

/** Chart series colors, validated for the dark surface (see styles/stats.css) */
const C = {
  line: '#149fbd',
  line2: '#e0559f',
  kinds: ['#149fbd', '#b9801c', '#8a6cf0', '#e0559f', '#3d7fd9'],
};
const BARS = 64;
const WINDOW = 10;

export function Dashboard({ state }: { state: AppState }) {
  const { blocks, config, tip } = state;
  const nodes = useMemo(() => Object.values(state.nodes), [state.nodes]);
  const labels = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.label])), [nodes]);

  const summary = useMemo(() => summarize(blocks), [blocks]);
  const fl = useMemo(() => fleet(nodes), [nodes]);
  const proposers = useMemo(() => topProposers(blocks, 36), [blocks]);

  // the first WINDOW points have a shorter window behind them, so they are not drawn
  const rounds = useMemo(() => blocks.slice(WINDOW).map((b) => b.round), [blocks]);
  const tps = useMemo(() => tpsSeries(blocks, WINDOW).slice(WINDOW), [blocks]);
  const blockTime = useMemo(() => blockTimeSeries(blocks, WINDOW).slice(WINDOW), [blocks]);
  const bars = useMemo(() => blocks.slice(-BARS), [blocks]);
  const timed = useMemo(() => blocks.filter((b) => b.p50 !== undefined).slice(-120), [blocks]);

  const newest = blocks[blocks.length - 1];
  const pulse = newest?.first ? { round: newest.round, id: newest.first } : undefined;
  const wall = useWallMode();
  const ago = (n: number) => `−${fmt.int((n * (summary.blockTime || 2.8)) / 60)} min`;

  return (
    <div className={`dash${wall.on ? ` dash--wall dash--stage-${wall.stage}` : ''}`}>
      <header className="topbar">
        <span className="brand-title">ALGOTRON</span>
        <span className="brand-subtitle">
          {config.networkLabel} · v{config.version}
        </span>
        <span className="topbar-spacer" />
        <RoundClock tipAt={state.tipAt} blockTime={summary.blockTime} />
        <span className="topbar-tip">
          TIP{' '}
          <a href={`${config.explorer}/block/${tip}`} target="_blank" rel="noreferrer" className="tip-value">
            #{tip.toLocaleString('en-US')}
          </a>
        </span>
        <button
          type="button"
          className={`wall-toggle${wall.on ? ' wall-toggle--on' : ''}`}
          onClick={wall.toggle}
        >
          {wall.on ? `WALL MODE · ${wall.stage.toUpperCase()} · MOVE POINTER TO EXIT` : 'WALL MODE'}
        </button>
        <span className={`topbar-link topbar-link--${state.connected ? 'up' : 'down'}`}>
          {state.connected ? '● LIVE' : '○ RECONNECTING'}
        </span>
      </header>

      <Kpis s={summary} f={fl} pollMs={config.pollMs} tps={tps} />

      <div className="dash-main">
        <div className="dash-left">
          <div className="globe-cell">
            <Globe nodes={nodes} pulse={pulse} follow={wall.on} />
            <Moments
              tps={tps}
              logs={state.logs}
              tipAt={state.tipAt}
              blockTime={summary.blockTime}
              connected={state.connected}
            />
          </div>
          <BlockRiver blocks={blocks} colors={C.kinds} explorer={config.explorer} labels={labels} />
        </div>

        <div className="dash-right">
          <div className="charts">
            <ChartPanel title="THROUGHPUT" note="TPS · 10-block window" value={fmt.num(summary.tps, 1)}>
              <LineChart
                rounds={rounds}
                series={[{ name: 'TPS', color: C.line, values: tps }]}
                unit={(v) => fmt.num(v, v < 10 ? 1 : 0)}
                left={ago(rounds.length)}
                fill
              />
            </ChartPanel>
            <ChartPanel
              title="TRANSACTIONS PER BLOCK"
              legend={TX_KINDS.map((k, i) => ({ name: TX_LABELS[k], color: C.kinds[i]! }))}
            >
              <StackChart
                rounds={bars.map((b) => b.round)}
                parts={bars.map(txParts)}
                names={TX_KINDS.map((k) => TX_LABELS[k])}
                colors={C.kinds}
                left={ago(bars.length)}
              />
            </ChartPanel>
            <ChartPanel
              title="BLOCK TIME"
              note="seconds · 10-block mean"
              value={`${fmt.num(summary.blockTime, 2)} s`}
            >
              <LineChart
                rounds={rounds}
                series={[{ name: 'block time', color: C.line, values: blockTime }]}
                unit={(v) => `${fmt.num(v, 1)}s`}
                left={ago(rounds.length)}
              />
            </ChartPanel>
            <ChartPanel
              title="BLOCK PROPAGATION"
              note="ms after first sighting"
              legend={[
                { name: 'median node', color: C.line },
                { name: '90th percentile', color: C.line2 },
              ]}
            >
              <LineChart
                rounds={timed.map((b) => b.round)}
                series={[
                  { name: 'median node', color: C.line, values: timed.map((b) => b.p50) },
                  { name: '90th percentile', color: C.line2, values: timed.map((b) => b.p90) },
                ]}
                unit={(v) => fmt.int(v)}
                left={ago(timed.length)}
              />
            </ChartPanel>
          </div>

          <div className="dash-stack">
            <HexWall nodes={nodes} tipBlock={tip} round={pulse?.round ?? 0} />
          </div>

          <div className="dash-bottom">
            <ProposerRing
              rows={proposers}
              newest={newest}
              explorer={config.explorer}
              blocks={blocks.length}
              color={C.line}
            />
            <TerminalPane logs={state.logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
