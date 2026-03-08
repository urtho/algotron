import type { NodeState } from '../types/index.js';
import { blockUrl } from '../config.js';

interface Props {
  node: NodeState;
  tipBlock: number;
}

/** Convert ISO 3166-1 alpha-2 code to a Unicode flag emoji */
function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '';
  const [a, b] = [...code.toUpperCase()];
  return (
    String.fromCodePoint(a.codePointAt(0)! + 127397) +
    String.fromCodePoint(b.codePointAt(0)! + 127397)
  );
}

export function NodeCard({ node, tipBlock }: Props) {
  const lag = tipBlock > 0 && node.lastBlock > 0 ? tipBlock - node.lastBlock : null;

  const flag = countryFlag(node.countryCode);

  const blockDisplay = node.lastBlock > 0
    ? lag !== null && lag > 0
      ? `#${node.lastBlock.toLocaleString()} (-${lag})`
      : `#${node.lastBlock.toLocaleString()}`
    : null;

  return (
    <div className={`node-card node-card--${node.status} node-card--${node.type}`}>
      <div className="node-card-header">
        <span className={`node-type-badge node-type-badge--${node.type}`}>
          {node.type === 'relay' ? 'R' : 'A'}
        </span>
        <span className="node-label">{node.label}</span>
        <span className={`node-status-dot status-${node.status}`} title={node.status} />
      </div>

      {(flag || node.city) && (
        <div className="node-card-geo">
          {flag && <span className="node-card-flag">{flag}</span>}
          {node.city}
        </div>
      )}

      <div className="node-card-blocks">
        {node.checkingBoot ? (
          <span className="node-scanning">SCAN<span className="ellipsis" /></span>
        ) : blockDisplay ? (
          <>
            <a
              href={blockUrl(node.lastBlock)}
              target="_blank"
              rel="noreferrer"
              className={`node-block-num${lag !== null && lag > 0 ? ' node-block-lagging' : ''}`}
            >
              {blockDisplay}
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}
