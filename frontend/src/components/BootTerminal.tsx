import { useEffect, useRef } from 'react';

interface Props {
  logs: string[];
}

export function BootTerminal({ logs }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Instantly pin the scroll to the bottom whenever a new line arrives
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="boot-overlay">
      <div className="boot-terminal">
        <div className="boot-header">
          <span className="boot-title">ALGOTRON // ALGORAND NETWORK DISCOVERY</span>
          <div className="boot-dots">
            <span className="dot dot-red" />
            <span className="dot dot-yellow" />
            <span className="dot dot-green" />
          </div>
        </div>
        <div className="boot-body" ref={bodyRef}>
          {logs.map((line, i) => (
            <div key={i} className="boot-line">
              {line || '\u00A0'}
            </div>
          ))}
          <div className="boot-cursor">█</div>
        </div>
      </div>
    </div>
  );
}
