import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../state.ts';
import { fmt } from '../stats.ts';

interface Moment {
  key: string;
  tone: 'burst' | 'warn' | 'bad' | 'ok';
  head: string;
  text: string;
}

const SHOW_MS = 9000;

/**
 * A banner over the globe when something happens: a throughput burst, a slow
 * round, a node that stops answering, falls far behind or comes back.
 */
export function Moments(props: {
  tps: number[];
  logs: LogEntry[];
  tipAt: number;
  blockTime: number;
  connected: boolean;
}) {
  const [moment, setMoment] = useState<Moment | null>(null);
  const lastBurst = useRef(0);
  const lastLog = useRef<number | null>(null);
  const slowFor = useRef(0);

  const show = setMoment;

  // burst: the 10-block TPS is far above what the window usually shows
  const now = props.tps[props.tps.length - 1] ?? 0;
  const sorted = [...props.tps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: evaluated once per new TPS value
  useEffect(() => {
    if (props.tps.length < 40 || median <= 0) return;
    if (now >= Math.max(30, median * 3) && Date.now() - lastBurst.current > 60_000) {
      lastBurst.current = Date.now();
      show({
        key: `burst-${Date.now()}`,
        tone: 'burst',
        head: `${fmt.int(now)} TPS`,
        text: `BURST · ${fmt.int(now / median)}× THE MEDIAN OF ${fmt.num(median, 1)}`,
      });
    }
  }, [now]);

  // node events arrive as warn/error log lines and as "recovered" lines
  const newestLog = props.logs[props.logs.length - 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: evaluated once per new log line
  useEffect(() => {
    if (!newestLog) return;
    if (lastLog.current === null) {
      lastLog.current = newestLog.id; // lines from before this page opened are history
      return;
    }
    const fresh = props.logs.filter((l) => l.id > lastLog.current!);
    lastLog.current = newestLog.id;
    const hit = fresh.findLast((l) => l.level !== 'info' || l.message.includes('recovered'));
    if (!hit) return;
    const [, tag = 'NODE', rest = hit.message] = hit.message.match(/^\[(\w+)\]\s*(.*)$/) ?? [];
    const ok = hit.message.includes('recovered');
    show({
      key: `log-${hit.id}`,
      tone: ok ? 'ok' : hit.message.includes('behind') ? 'warn' : 'bad',
      head: tag,
      text: rest.toUpperCase(),
    });
  }, [newestLog?.id]);

  // slow round: no new block for four block times
  useEffect(() => {
    const t = setInterval(() => {
      if (!props.tipAt || !props.connected) return;
      const age = (Date.now() - props.tipAt) / 1000;
      const expect = props.blockTime || 2.8;
      if (age > expect * 4 && slowFor.current !== props.tipAt) {
        slowFor.current = props.tipAt;
        show({
          key: `slow-${props.tipAt}`,
          tone: 'warn',
          head: 'SLOW ROUND',
          text: `NO NEW BLOCK FOR ${fmt.int(age)} S · USUAL ${fmt.num(expect, 1)} S`,
        });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [props.tipAt, props.blockTime, props.connected]);

  useEffect(() => {
    if (!moment) return;
    const t = setTimeout(() => setMoment(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [moment]);

  if (!moment) return null;
  return (
    <div key={moment.key} className={`moment moment--${moment.tone}`} role="status">
      <b>{moment.head}</b>
      <span>{moment.text}</span>
    </div>
  );
}
