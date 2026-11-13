import { useEffect, useState } from 'react';
import type { RankNode } from '../../../shared/types.ts';
import { useRank } from '../useRank.ts';

const TURN_MS = 8000;

/**
 * League leaders on the monitor: for one medal category at a time, who holds gold in each stake league in the
 * running season. Turns to the next category every few seconds; each name opens the leagues on that node.
 */
export function Podium() {
  const { snap } = useRank();
  const [turn, setTurn] = useState(0);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    const timer = setInterval(() => setTurn((t) => t + 1), TURN_MS);
    return () => clearInterval(timer);
  }, [held]);

  const season = snap?.seasons[snap.seasons.length - 1];
  // only categories that award medals every season have a leader to show
  const cats = snap?.categories.filter((c) => (c.medals ?? 'season') === 'season') ?? [];
  if (!snap || !season || cats.length === 0) return null;
  const cat = cats[turn % cats.length]!;
  const gold = (league: string): RankNode[] =>
    season.nodes.filter((n) => n.league === league && n.c[cat.id]?.[2] === 1);

  return (
    <div className="podium" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
      <div className="podium-head">
        <span>LEAGUE LEADERS</span>
        <span className="podium-dots" aria-hidden="true">
          {cats.map((c, i) => (
            <i key={c.id} className={i === turn % cats.length ? 'on' : ''} />
          ))}
        </span>
      </div>
      <div className="podium-cat" key={cat.id}>
        {cat.name.toUpperCase()}
      </div>
      {snap.leagues.map((l) => {
        const first = gold(l.id);
        return (
          <div className="podium-row" key={l.id}>
            <span className="podium-league">{(l.title ?? `League ${l.id}`).toUpperCase()}</span>
            {first[0] ? (
              <a
                href={`#leagues/${first[0].id}`}
                title={`Leads ${l.title ?? l.id} (${l.name} ALGO) in ${cat.name}`}
              >
                {first[0].alias ?? first[0].id}
                {first.length > 1 && <span className="podium-more"> +{first.length - 1}</span>}
              </a>
            ) : (
              <span className="podium-none">not enough votes yet</span>
            )}
          </div>
        );
      })}
      <a className="podium-all" href="#leagues">
        SEASON OF {season.wk} · ALL STANDINGS →
      </a>
    </div>
  );
}
