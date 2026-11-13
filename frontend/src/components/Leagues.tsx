import { useEffect, useMemo, useState } from 'react';
import type { RankCell, RankNode } from '../../../shared/types.ts';
import { type MyVotes, useMyVotes } from '../avstream.ts';
import { MAX_ADDRS, parseAddresses, mine as pins, useMine } from '../mine.ts';
import { statementFromHash } from '../own.ts';
import { BAND_TEXT, band, findNode, parseQuery, tenureText, tenureYears } from '../rank.ts';
import { fmt } from '../stats.ts';
import { useRank } from '../useRank.ts';
import { NodeCats, Prove, Verify } from './Own.tsx';
import '../styles/leagues.css';

const MEDAL = ['', 'GOLD', 'SILVER', 'BRONZE'];
const UNIT = { rank: '', ms: ' ms', days: ' d', hours: ' h' } as const;

/** What each category measures, in the words shown under the table */
const ABOUT: Record<string, string> = {
  soft: "How tightly a node's soft votes land around its own best time. Adjusted, so distance from the relays does not count.",
  cert: 'The same for cert votes.',
  late: "How rarely a soft vote arrives far behind the node's own best time.",
  valid:
    'Median time to validate a block, as the node reports it. Ranked and badged, but it awards no medals: the same machines would win every week.',
  streak: 'Days in a row with every round reported and no catchup.',
  upgrade:
    'Who ran the newest stable release first. The hours count from the moment the third node showed it. Medals are awarded once per release, in the season its seventh day falls in.',
};

const name = (n: RankNode) => n.alias ?? n.id;

function Cell({ cell, unit }: { cell?: RankCell; unit: string }) {
  if (!cell) return <td className="lg-cell lg-cell--none">·</td>;
  const [rank, field, medal, home, os, value] = cell;
  return (
    <td
      className={`lg-cell lg-band-${band(rank, field)}`}
      title={`${rank} of ${field} · ${BAND_TEXT[band(rank, field)]}`}
    >
      {medal > 0 && (
        <span className={`lg-medal lg-medal-${medal}`} title={`${MEDAL[medal]} in this league`}>
          {medal}
        </span>
      )}
      {home === 1 && (
        <span className="lg-badge" title="Among the best home nodes in this category">
          H
        </span>
      )}
      {os === 1 && (
        <span className="lg-badge" title="Among the best nodes on its operating system in this category">
          OS
        </span>
      )}
      <span className="lg-rank">{rank}</span>
      {value !== null && unit && (
        <span className="lg-value">
          {value}
          {unit}
        </span>
      )}
    </td>
  );
}

/**
 * The voting addresses of one pinned node. The ranking does not say which accounts a node votes with, so the
 * visitor gives them, and the monitor then marks those accounts' votes and proposals. They are kept on this
 * device only; `feed` tells whether the public vote stream knows each one as a voter.
 */
function Addresses({ id, list, feed }: { id: string; list: string[]; feed: MyVotes }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const add = () => {
    const { ok, bad } = parseAddresses(text);
    if (ok.length === 0 && bad.length === 0) return;
    const room = MAX_ADDRS - list.length;
    if (ok.length) pins.addAddresses(id, ok);
    // what was not taken stays in the box to be corrected
    setText(bad.join(' '));
    setNote(
      bad.length
        ? 'Not an Algorand address: it has 58 characters, A to Z and 2 to 7. Left in the box.'
        : ok.filter((a) => !list.includes(a)).length > room
          ? `A node keeps ${MAX_ADDRS} addresses at most.`
          : '',
    );
  };
  const state = (a: string) =>
    !feed.live ? 'waiting for the vote feed' : feed.seen.has(a) ? 'seen voting' : 'not seen voting yet';

  return (
    <div className="lg-addrs">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label htmlFor={`lg-a-${id}`}>VOTING ADDRESSES</label>
        <input
          id={`lg-a-${id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="the accounts this node votes with, one or several"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">ADD</button>
      </form>
      {note && <p className="lg-note">{note}</p>}
      {list.length > 0 && (
        <ul className="lg-addr-list">
          {list.map((a) => (
            <li key={a}>
              <span className="lg-addr" title={a}>
                {fmt.addr(a)}
              </span>
              <span className={feed.live && feed.seen.has(a) ? 'lg-addr-seen' : 'lg-dim'}>{state(a)}</span>
              <button
                type="button"
                className="lg-linkish"
                aria-label={`Remove ${fmt.addr(a)}`}
                onClick={() => pins.removeAddress(id, a)}
              >
                REMOVE
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The validator leagues: one table per stake league, a column per category. The page loads the same snapshot for
 * every visitor and finds "my node" in it locally; what is typed into the search box stays on the device.
 * `votes`: the monitor can mark a visitor's own votes, so a pinned node takes voting addresses.
 */
export function Leagues({ votes }: { votes: boolean }) {
  const { snap, error } = useRank();
  const me = useMine();
  const mine = me.ids;
  const feed = useMyVotes();
  const [back, setBack] = useState(0);
  const [league, setLeague] = useState('');
  const [sort, setSort] = useState('cert');
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState('');

  const season = snap ? snap.seasons[Math.max(0, snap.seasons.length - 1 - back)] : undefined;
  // a link may point at a node (#leagues/<id>): the fragment stays in the browser, so the server still does not see it
  useEffect(() => {
    const id = /^#leagues\/([0-9a-f]{12})$/.exec(location.hash)?.[1];
    const hit = id ? findNode(snap?.seasons[snap.seasons.length - 1], { id }) : undefined;
    if (hit) {
      setLeague(hit.league);
      setOpen(hit.id);
    }
  }, [snap]);
  const myNodes = useMemo(() => mine.map((id) => ({ id, node: findNode(season, { id }) })), [mine, season]);
  // open on the league of the visitor's first node, else on the largest league
  const shown =
    league ||
    myNodes.find((m) => m.node)?.node?.league ||
    snap?.leagues.reduce((a, b) => (count(season, b.id) > count(season, a.id) ? b : a)).id ||
    '';

  const rows = useMemo(() => {
    const list = (season?.nodes ?? []).filter((n) => n.league === shown);
    const key = (n: RankNode) => n.c[sort]?.[0] ?? Number.MAX_SAFE_INTEGER;
    return list.sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id));
  }, [season, shown, sort]);

  if (!snap || !season) {
    return (
      <div className="lg">
        <Top />
        <div className="lg-wait">{error || 'LOADING THE RANKING…'}</div>
      </div>
    );
  }

  const cats = snap.categories;
  // under each column head: what the column awards in the season on screen
  const headNote = (medals?: string) => {
    if (medals === 'never') return 'no medals';
    if (medals !== 'release') return 'medals weekly';
    const r = snap.release;
    if (!r) return 'medals per release';
    return r.medal_season === season.wk
      ? `${r.version} · medals this season`
      : `${r.version} · no medals this season`;
  };
  // a snapshot from before the leagues had names shows their letters
  const title = (id: string) =>
    (snap.leagues.find((l) => l.id === id)?.title ?? `LEAGUE ${id}`).toUpperCase();
  const find = () => {
    const q = parseQuery(query);
    const hit = findNode(season, q);
    if (!hit) {
      setNote(
        q.id || q.alias
          ? 'Not in this season. A node is ranked after 5 days of voting with online stake; an alias needs a telemetry name starting with @.'
          : 'Paste the telemetry GUID of your node, its last 12 characters, or its @alias.',
      );
      return;
    }
    pins.pin(hit.id);
    setLeague(hit.league);
    setOpen(hit.id);
    setQuery('');
    setNote('');
  };

  return (
    <div className="lg">
      <Top />
      <div className="lg-body">
        <section className="lg-intro">
          <h1>VALIDATOR LEAGUES</h1>
          <p>
            Nodes that send telemetry, ranked by season (Monday to Sunday, UTC) in four stake leagues. There
            is no single score: each category has its own table, medals and badges. Nodes with more than 4
            voting accounts are ranked but take no medals.
          </p>
          <div className="lg-controls">
            <span className="seg">
              {snap.seasons
                .slice()
                .reverse()
                .map((s, i) => (
                  <button
                    key={s.wk}
                    type="button"
                    className={`seg-item${i === back ? ' seg-item--on' : ''}`}
                    aria-pressed={i === back}
                    onClick={() => setBack(i)}
                  >
                    {s.final ? `SEASON OF ${s.wk} · FINAL` : `SEASON OF ${s.wk} · RUNNING`}
                  </button>
                ))}
            </span>
            <span className="lg-computed">
              computed {season.computed.replace('T', ' ').replace('Z', ' UTC')}
            </span>
          </div>
        </section>

        <section className="lg-me">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              find();
            }}
          >
            <label htmlFor="lg-q">FIND MY NODE</label>
            <input
              id="lg-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="telemetry GUID, its last 12 characters, or @alias"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit">PIN</button>
          </form>
          <p className="lg-private">
            Everyone downloads the same ranking file. Your node is found in it on this device; what you type
            here is not sent.
          </p>
          {note && <p className="lg-note">{note}</p>}
          {snap.own && mine.length > 0 && (
            <p className="lg-private">
              To show others that a pinned node is yours, give the first 8 characters of its telemetry GUID.
              This device turns them into the node's key and compares it with the one in the ranking file;
              with the key you can sign a line that anyone can check. The 8 characters and the key stay on
              this device.
            </p>
          )}
          {votes && mine.length > 0 && (
            <p className="lg-private">
              Optional: add the accounts a pinned node votes with, and the monitor marks their votes on the
              arrival curves (BY ADDRESS) and their proposals on the proposals chart. The ranking does not
              know which accounts belong to a node. The addresses stay on this device too: the page reads the
              public vote feed, the same for everyone, and finds your accounts in it here.
            </p>
          )}
          {myNodes.map(({ id, node }) => (
            <div key={id} className="lg-mine">
              <div className="lg-mine-head">
                <span className="lg-mine-name">{node ? name(node) : id}</span>
                {node ? (
                  <button type="button" className="lg-linkish" onClick={() => setLeague(node.league)}>
                    {title(node.league)}
                  </button>
                ) : (
                  <span className="lg-dim">not ranked in this season</span>
                )}
                <button type="button" className="lg-linkish" onClick={() => pins.forget(id)}>
                  FORGET
                </button>
              </div>
              {node && <NodeCats node={node} cats={cats} />}
              {node && snap.own?.keys[id] && <Prove id={id} own={snap.own} />}
              {votes && <Addresses id={id} list={me.addrs[id] ?? []} feed={feed} />}
            </div>
          ))}
        </section>

        <nav className="lg-leagues" aria-label="Leagues">
          {snap.leagues.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`lg-league${l.id === shown ? ' lg-league--on' : ''}`}
              aria-pressed={l.id === shown}
              onClick={() => setLeague(l.id)}
            >
              <span className="lg-league-id">{title(l.id)}</span>
              <span className="lg-league-name">{l.name} ALGO</span>
              <span className="lg-league-n">{count(season, l.id)} nodes</span>
            </button>
          ))}
        </nav>

        <div className="lg-scroll">
          <table className="lg-table">
            <thead>
              <tr>
                <th className="lg-th-node">NODE</th>
                {cats.map((c) => (
                  <th key={c.id} aria-sort={c.id === sort ? 'ascending' : undefined}>
                    <button
                      type="button"
                      className={c.id === sort ? 'lg-sort lg-sort--on' : 'lg-sort'}
                      title={ABOUT[c.id]}
                      onClick={() => setSort(c.id)}
                    >
                      {c.name.toUpperCase()}
                    </button>
                    <span className="lg-th-note">{headNote(c.medals)}</span>
                  </th>
                ))}
                <th className="lg-th-tenure" title="Time since the node first sent telemetry">
                  TENURE
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr
                  key={n.id}
                  className={`${mine.includes(n.id) ? 'lg-row--mine' : ''}${open === n.id ? ' lg-row--open' : ''}`}
                  onClick={() => setOpen(open === n.id ? '' : n.id)}
                >
                  <td className="lg-node">
                    <span className="lg-node-name">{name(n)}</span>
                    {mine.includes(n.id) && <span className="lg-tag lg-tag--me">YOU</span>}
                    {n.home === 1 && (
                      <span className="lg-tag" title="Connects from a home network">
                        HOME
                      </span>
                    )}
                    {n.os && <span className="lg-tag">{n.os.toUpperCase()}</span>}
                    {n.over === 1 && (
                      <span
                        className="lg-tag lg-tag--over"
                        title="More than 4 voting accounts on one node: ranked, no medals"
                      >
                        OVER 4 ACCOUNTS
                      </span>
                    )}
                  </td>
                  {cats.map((c) => (
                    <Cell key={c.id} cell={n.c[c.id]} unit={UNIT[c.shows]} />
                  ))}
                  <td className="lg-tenure" title={`${n.tenure} days since this node first sent telemetry`}>
                    {tenureYears(n.tenure) > 0 && <span className="lg-years">{tenureYears(n.tenure)}Y</span>}
                    {tenureText(n.tenure)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="lg-legend">
          <h2>WHAT IS MEASURED</h2>
          <dl>
            {cats.map((c) => (
              <div key={c.id}>
                <dt>{c.name}</dt>
                <dd>{ABOUT[c.id]}</dd>
              </div>
            ))}
          </dl>
          <p>
            A number is the node's place in its league. <span className="lg-medal lg-medal-1">1</span>
            <span className="lg-medal lg-medal-2">2</span>
            <span className="lg-medal lg-medal-3">3</span> mark the season's medals,{' '}
            <span className="lg-badge">H</span> the best home nodes and <span className="lg-badge">OS</span>{' '}
            the best nodes on each operating system, across all leagues. Equal results share a place and a
            medal. <span className="lg-years">1Y</span> marks each full year a node has been reporting. Vote
            timing is shown as a place only, never in milliseconds. To leave the ranking, put #norank in your
            node's telemetry name; to show a name instead of an ID, start the telemetry name with @.
          </p>
        </section>
      </div>
    </div>
  );
}

const count = (season: { nodes: RankNode[] } | undefined, league: string) =>
  season ? season.nodes.filter((n) => n.league === league).length : 0;

export function Top({ sub = 'LEAGUES' }: { sub?: string }) {
  return (
    <header className="topbar lg-top">
      <span className="brand-title">ALGOTRON</span>
      <span className="brand-subtitle">{sub}</span>
      <nav className="topbar-nav" aria-label="Views">
        {sub !== 'LEAGUES' && <a href="#leagues">LEAGUES</a>}
        <a href="#">← NETWORK MONITOR</a>
      </nav>
    </header>
  );
}

/** The page behind a statement link (#verify/…): a line signed with a node's key, checked on this device */
export function VerifyPage({ hash }: { hash: string }) {
  const statement = useMemo(() => statementFromHash(hash), [hash]);
  return (
    <div className="lg">
      <Top sub="VERIFY" />
      <div className="lg-body">
        <Verify statement={statement} />
      </div>
    </div>
  );
}
