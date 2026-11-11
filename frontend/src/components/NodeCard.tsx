import type { NodeState } from '../../../shared/types.ts';

interface Props {
  node: NodeState;
  tipBlock: number;
}

/** ISO 3166-1 alpha-2 code to a flag emoji */
function countryFlag(code: string): string {
  if (code.length !== 2) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => c.codePointAt(0)! + 127397));
}

export function NodeCard({ node, tipBlock }: Props) {
  const lag = tipBlock > 0 && node.lastBlock > 0 ? tipBlock - node.lastBlock : 0;
  const flag = countryFlag(node.countryCode);

  let line: string;
  if (node.status === 'offline') line = node.err ? node.err.toUpperCase() : 'NO ANSWER';
  else if (node.status === 'unknown') line = '';
  else if (lag > 0) line = `#${node.lastBlock.toLocaleString('en-US')} (-${lag.toLocaleString('en-US')})`;
  else line = `#${node.lastBlock.toLocaleString('en-US')}`;

  return (
    <div
      className={`node-card node-card--${node.status} node-card--${node.type}`}
      title={`${node.host}:${node.port} · ${node.ip}${node.ip6 ? ` · IPv6 ${node.v6 ?? '?'}` : ''} · ${node.net}`}
    >
      <div className="node-card-header">
        <span className={`node-type-badge node-type-badge--${node.type}`}>
          {node.type === 'relay' ? 'R' : 'A'}
        </span>
        <span className="node-label">{node.label}</span>
        {node.rtt > 0 && node.status !== 'offline' && (
          <span className="node-rtt">{Math.round(node.rtt)}ms</span>
        )}
        <span className={`node-status-dot status-${node.status}`} title={node.status} />
      </div>

      {(flag || node.city) && (
        <div className="node-card-geo">
          {flag && <span className="node-card-flag">{flag}</span>}
          {node.city}
        </div>
      )}

      <div className="node-card-blocks">
        {node.status === 'unknown' ? (
          <span className="node-scanning">
            SCAN
            <span className="ellipsis" />
          </span>
        ) : (
          <span className="node-block-num">{line}</span>
        )}
      </div>
    </div>
  );
}
