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
  wavePlan,
} from '../stats.ts';
import { ChartPanel, FlowChart, SplitChart } from './Chart.tsx';
import { Globe } from './Globe.tsx';
import { HexWall } from './HexWall.tsx';
import { Kpis } from './Kpis.tsx';
import { Moments } from './Moments.tsx';
import { ProposerRing } from './ProposerRing.tsx';
import { RoundClock } from './RoundClock.tsx';
import { VoteBoxes } from './VoteBoxes.tsx';
import { VoteCurves } from './VoteCurves.tsx';

/** Chart series colors, validated for the dark surface (see styles/stats.css) */
const C = {
  line: '#149fbd',
  median: '#b9801c',
  p90: '#e0559f',
  kinds: ['#149fbd', '#b9801c', '#8a6cf0', '#e0559f', '#3d7fd9'],
};
/** Rounds on the two combined charts, about 5.5 minutes */
const RECENT = 120;
const WINDOW = 10;

export function Dashboard({ state }: { state: AppState }) {
  const { blocks, config, tip } = state;
  const nodes = useMemo(() => Object.values(state.nodes), [state.nodes]);

  const summary = useMemo(() => summarize(blocks), [blocks]);
  const fl = useMemo(() => fleet(nodes), [nodes]);
  const proposers = useMemo(() => topProposers(blocks, 36), [blocks]);

  // the first WINDOW points have a shorter window behind them, so they are not drawn
  const tps = useMemo(() => tpsSeries(blocks, WINDOW).slice(WINDOW), [blocks]);
  // both combined charts show the same rounds
  const view = useMemo(() => {
    const from = Math.max(WINDOW, blocks.length - RECENT);
    const shown = blocks.slice(from);
    return {
      rounds: shown.map((b) => b.round),
      tps: tpsSeries(blocks, WINDOW).slice(from),
      blockTime: blockTimeSeries(blocks, WINDOW).slice(from),
      parts: shown.map(txParts),
      p50: shown.map((b) => b.p50),
      p90: shown.map((b) => b.p90),
    };
  }, [blocks]);

  const newest = blocks[blocks.length - 1];
  const av = config.propSource === 'avmonitor';
  const plan = useMemo(() => wavePlan(state.wave), [state.wave]);
  const ago = (n: number) => `−${fmt.int((n * (summary.blockTime || 2.8)) / 60)} min`;

  return (
    <div className="dash">
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
        <span className={`topbar-link topbar-link--${state.connected ? 'up' : 'down'}`}>
          {state.connected ? '● LIVE' : '○ RECONNECTING'}
        </span>
      </header>

      <Kpis s={summary} f={fl} pollMs={config.pollMs} tps={tps} av={av} />

      <div className="dash-main">
        <div className="dash-left">
          <div className="globe-cell">
            <Globe nodes={nodes} wave={state.wave} />
            <div className="globe-note">
              Approximate locations of relays, not validators.
              <br />
              {av
                ? 'Burst starts at the first relay to see the winning proposal, not at the proposer.'
                : 'Burst starts at the first node to show the block, not at the proposer.'}
            </div>
            <Moments
              tps={tps}
              logs={state.logs}
              tipAt={state.tipAt}
              blockTime={summary.blockTime}
              connected={state.connected}
            />
            <ProposerRing rows={proposers} newest={newest} color={C.line} />
          </div>
        </div>

        <div className="dash-right">
          <div className="charts">
            <ChartPanel
              title="THROUGHPUT"
              legend={TX_KINDS.map((k, i) => ({ name: TX_LABELS[k], color: C.kinds[i]! }))}
              value={`${fmt.num(summary.tps, 1)} TPS`}
            >
              <FlowChart
                rounds={view.rounds}
                tps={view.tps}
                parts={view.parts}
                names={TX_KINDS.map((k) => TX_LABELS[k])}
                colors={C.kinds}
                lineColor={C.line}
                left={ago(view.rounds.length)}
              />
            </ChartPanel>
            <ChartPanel
              title="BLOCK TIME · PROPAGATION"
              legend={[
                { name: 'block time', color: C.line },
                { name: 'median node', color: C.median },
                { name: '90th percentile', color: C.p90 },
              ]}
              value={`${fmt.num(summary.blockTime, 2)} s`}
            >
              <SplitChart
                rounds={view.rounds}
                top={{ name: 'block time', color: C.line, values: view.blockTime }}
                topUnit={(v) => `${fmt.num(v, 2)}s`}
                topLabel="BLOCK TIME · 10-BLOCK MEAN"
                bottom={[
                  { name: 'median node', color: C.median, values: view.p50 },
                  { name: '90th percentile', color: C.p90, values: view.p90 },
                ]}
                bottomUnit={(v) => fmt.int(v)}
                bottomLabel={av ? 'PROPOSAL · MS AFTER FIRST RELAY' : 'BLOCK · MS AFTER FIRST SIGHTING'}
                left={ago(view.rounds.length)}
              />
            </ChartPanel>
          </div>

          <div className="dash-stack">
            <HexWall nodes={nodes} tipBlock={tip} wave={state.wave} plan={plan} />
          </div>

          <div className="dash-bottom">
            <VoteBoxes blocks={blocks} colors={C.kinds} />
          </div>
        </div>
      </div>

      <div className="dash-band">
        <VoteCurves wave={state.wave} colors={C.kinds} />
      </div>
    </div>
  );
}
