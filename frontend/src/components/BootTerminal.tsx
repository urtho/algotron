import { useEffect, useRef, useState } from 'react';

interface Props {
  lines: string[];
  /** The backend has data; the terminal may close once every line is shown */
  ready: boolean;
  onDone: () => void;
}

/** Types the backend's discovery log out line by line, then hands over to the dashboard. */
export function BootTerminal({ lines, ready, onDone }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= lines.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 55);
    return () => clearTimeout(t);
  }, [shown, lines.length]);

  useEffect(() => {
    if (!ready || shown < lines.length || lines.length === 0) return;
    const t = setTimeout(onDone, 700);
    return () => clearTimeout(t);
  }, [ready, shown, lines.length, onDone]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line is added
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [shown]);

  const waiting = shown >= lines.length && !ready;
  return (
    <div className="boot-overlay">
      <div className="boot-terminal">
        <div className="boot-header">
          <span className="boot-title">{'ALGOTRON // ALGORAND NETWORK DISCOVERY'}</span>
          <div className="boot-dots">
            <span className="dot dot-red" />
            <span className="dot dot-yellow" />
            <span className="dot dot-green" />
          </div>
        </div>
        <div className="boot-body" ref={body}>
          {lines.slice(0, shown).map((line, i) => (
            <div key={i} className="boot-line">
              {line || ' '}
            </div>
          ))}
          {lines.length === 0 && <div className="boot-line">Connecting to the Algotron backend…</div>}
          {waiting && lines.length > 0 && (
            <div className="boot-line">
              [BOOT] Reading the chain tip and recent blocks
              <span className="ellipsis" />
            </div>
          )}
          <div className="boot-cursor">█</div>
        </div>
      </div>
    </div>
  );
}
