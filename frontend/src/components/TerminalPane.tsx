import { useEffect, useRef } from 'react';
import type { LogEntry } from '../types/index.js';

interface Props {
  logs: LogEntry[];
}

const LEVEL_CLASS: Record<string, string> = {
  info: 'log-info',
  warn: 'log-warn',
  error: 'log-error',
};

function formatTime(ts: number): string {
  return new Date(ts).toISOString().substring(11, 23);
}

export function TerminalPane({ logs }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);

  // Track scroll position *before* new content arrives
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll using the pre-render near-bottom state
  useEffect(() => {
    if (wasNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [logs]);

  return (
    <div className="terminal-pane">
      <div className="terminal-pane-header">
        <span className="panel-title">SYSTEM LOG</span>
        <span className="terminal-pane-count">{logs.length} entries</span>
      </div>
      <div className="terminal-pane-body" ref={containerRef}>
        {logs.map(entry => (
          <div key={entry.id} className={`log-line ${LEVEL_CLASS[entry.level] ?? 'log-info'}`}>
            <span className="log-time">{formatTime(entry.ts)}</span>
            <span className="log-sep"> </span>
            <span className="log-msg">{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
