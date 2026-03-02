import { Globe } from './Globe.js';
import { NodeGrid } from './NodeGrid.js';
import { TerminalPane } from './TerminalPane.js';
import type { AppState } from '../types/index.js';

interface Props {
  state: AppState;
}

const HEALTHY = new Set(['synced', 'lagging', 'orange']);

export function Dashboard({ state }: Props) {
  const nodes = Object.values(state.nodes);

  const healthyRelays = nodes.filter(n => n.type === 'relay' && HEALTHY.has(n.status)).length;
  const healthyArchivers = nodes.filter(n => n.type === 'archiver' && HEALTHY.has(n.status)).length;

  return (
    <div className="dashboard">
      {/* ── Left panel: Globe ─────────────────────────────────── */}
      <div className="dashboard-left">
        <div className="dashboard-brand">
          <span className="brand-title">ALGOTRON</span>
          <span className="brand-subtitle">ALGORAND MAINNET</span>
        </div>
        <Globe
          nodes={nodes}
          healthyRelays={healthyRelays}
          healthyArchivers={healthyArchivers}
        />
      </div>

      {/* ── Right panel: monitors + log ───────────────────────── */}
      <div className="dashboard-right">
        <div className="dashboard-right-top">
          <NodeGrid nodes={nodes} tipBlock={state.tipBlock} />
        </div>
        <div className="dashboard-right-bottom">
          <TerminalPane logs={state.logs} />
        </div>
      </div>
    </div>
  );
}
