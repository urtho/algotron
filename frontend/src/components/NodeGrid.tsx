import { NodeCard } from './NodeCard.js';
import type { NodeState } from '../types/index.js';

interface Props {
  nodes: NodeState[];
  tipBlock: number;
}

export function NodeGrid({ nodes, tipBlock }: Props) {
  const relays = nodes.filter(n => n.type === 'relay');
  const archivers = nodes.filter(n => n.type === 'archiver');

  return (
    <div className="node-grid-container">
      <div className="node-grid-header">
        <span className="panel-title">NETWORK HEALTH MONITORS</span>
        <span className="node-grid-tip">
          TIP: <span className="tip-value">#{tipBlock.toLocaleString()}</span>
        </span>
      </div>

      {archivers.length > 0 && (
        <div className="node-grid-section">
          <div className="node-grid-section-label">ARCHIVERS ({archivers.length})</div>
          <div className="node-grid">
            {archivers.map(n => (
              <NodeCard key={n.id} node={n} tipBlock={tipBlock} />
            ))}
          </div>
        </div>
      )}

      {relays.length > 0 && (
        <div className="node-grid-section">
          <div className="node-grid-section-label">RELAYS ({relays.length})</div>
          <div className="node-grid">
            {relays.map(n => (
              <NodeCard key={n.id} node={n} tipBlock={tipBlock} />
            ))}
          </div>
        </div>
      )}

      {nodes.length === 0 && (
        <div className="node-grid-empty">Discovering nodes<span className="ellipsis" /></div>
      )}
    </div>
  );
}
