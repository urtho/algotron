import { useEffect, useState } from 'react';
import type { RankNode, RankOwn, RankSnapshot } from '../../../shared/types.ts';
import {
  deriveKey,
  MAX_SAYS,
  type OwnKey,
  parseFirst8,
  type Statement,
  signStatement,
  statementLink,
  verifyStatement,
} from '../own.ts';
import { BAND_TEXT, band, findNode } from '../rank.ts';
import { useRank } from '../useRank.ts';

const MEDAL = ['', 'GOLD', 'SILVER', 'BRONZE'];

/** One node's place in each category of a season */
export function NodeCats({ node, cats }: { node: RankNode; cats: RankSnapshot['categories'] }) {
  return (
    <div className="lg-mine-cats">
      {cats.map((c) => {
        const cell = node.c[c.id];
        return (
          <div key={c.id} className={`lg-mine-cat${cell ? ` lg-band-${band(cell[0], cell[1])}` : ''}`}>
            <span className="lg-mine-label">{c.name}</span>
            <span className="lg-mine-rank">
              {cell && cell[2] > 0 && (
                <span className={`lg-medal lg-medal-${cell[2]}`} title={`${MEDAL[cell[2]]} in this league`}>
                  {cell[2]}
                </span>
              )}
              {cell ? `${cell[0]} / ${cell[1]}` : 'not enough data'}
            </span>
            {cell && <span className="lg-dim">{BAND_TEXT[band(cell[0], cell[1])]}</span>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * "Prove it's yours" on a pinned node: the visitor types the first 8 characters of the node's telemetry GUID, the
 * device derives the node's key from them and compares it with the one in the ranking. With the key in hand the
 * visitor signs a line and gets a link anyone can check. The key lives in this component only: it is gone when
 * the page closes, and neither it nor the 8 characters are sent anywhere.
 */
export function Prove({ id, own }: { id: string; own: RankOwn }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<OwnKey>();
  const [says, setSays] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);

  const check = async () => {
    const { first8, wrong } = parseFirst8(text, id);
    if (!first8) {
      setNote(
        wrong
          ? 'That GUID belongs to another node.'
          : "Type the first 8 characters of this node's telemetry GUID (0 to 9, a to f), or paste the whole GUID.",
      );
      return;
    }
    setBusy(true);
    setNote('');
    // let "CHECKING" paint first: the hash holds the page for about a second
    await new Promise((r) => setTimeout(r, 40));
    try {
      const k = await deriveKey(first8, id, own);
      if (k.pub === own.keys[id]) {
        setKey(k);
        setText('');
      } else setNote("Those are not the first 8 characters of this node's GUID.");
    } catch (err) {
      setNote(`This device could not run the check: ${err instanceof Error ? err.message : String(err)}`);
    }
    setBusy(false);
  };

  const sign = async () => {
    if (!key) return;
    try {
      setLink(statementLink(await signStatement(key, id, says)));
      setCopied(false);
      setNote('');
    } catch {
      setNote('Type what the statement should say.');
    }
  };

  if (!key) {
    return (
      <div className="lg-own">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <label htmlFor={`lg-o-${id}`}>PROVE IT'S YOURS</label>
          <input
            id={`lg-o-${id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="first 8 characters of this node's telemetry GUID"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy}
            title="Checked on this device. Nothing is sent, and it does not reveal who you are."
          >
            {busy ? 'CHECKING…' : 'CHECK'}
          </button>
        </form>
        {note && <p className="lg-note">{note}</p>}
        <p className="lg-private">
          Where to find the GUID: on the node, run <code>diagcfg telemetry status</code> (add <code>-d</code>{' '}
          and the data directory if it asks), or read <code>GUID</code> in <code>logging.config</code> in the
          data directory. The 8 characters are the part before the first dash.
        </p>
        <p className="lg-private lg-own-local">
          CHECK runs on this device. Nothing you type is sent, so it does not reveal who you are or which node
          you looked at.
        </p>
      </div>
    );
  }

  return (
    <div className="lg-own">
      <p className="lg-own-ok">
        PROVEN ON THIS DEVICE <span className="lg-dim">· the key is kept until this page closes</span>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sign();
        }}
      >
        <label htmlFor={`lg-s-${id}`}>SIGN A LINE</label>
        <input
          id={`lg-s-${id}`}
          value={says}
          onChange={(e) => setSays(e.target.value)}
          placeholder="what to say: a handle, or a text you were asked to sign"
          maxLength={MAX_SAYS}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">SIGN</button>
      </form>
      {note && <p className="lg-note">{note}</p>}
      {link && (
        <div className="lg-own-link">
          <input
            readOnly
            value={link}
            aria-label="Link to the signed statement"
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="lg-linkish"
            onClick={() => {
              navigator.clipboard.writeText(link).then(
                () => setCopied(true),
                () => setNote('Clipboard unavailable. Select the link and copy it.'),
              );
            }}
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
          <a className="lg-linkish" href={link} target="_blank" rel="noreferrer">
            OPEN
          </a>
        </div>
      )}
      <p className="lg-private">
        Anyone with the link can check that the line was signed with this node's key and see the node's
        places. It names the node, not an account.
      </p>
    </div>
  );
}

type Verdict = 'checking' | 'valid' | 'invalid' | 'nokey';

/**
 * The page behind a statement link. The statement travels in the address fragment, so the server never receives
 * it; the signature is checked here against the key the ranking lists for the node.
 */
export function Verify({ statement }: { statement: Statement | undefined }) {
  const { snap, error } = useRank();
  const [verdict, setVerdict] = useState<Verdict>('checking');
  const pub = statement && snap ? (snap.own?.keys[statement.n] ?? '') : undefined;

  useEffect(() => {
    if (!statement || pub === undefined) return;
    if (!pub) {
      setVerdict('nokey');
      return;
    }
    let live = true;
    setVerdict('checking');
    void verifyStatement(statement, pub).then((ok) => {
      if (live) setVerdict(ok ? 'valid' : 'invalid');
    });
    return () => {
      live = false;
    };
  }, [statement, pub]);

  const season = snap?.seasons[snap.seasons.length - 1];
  const node = statement ? findNode(season, { id: statement.n }) : undefined;
  const who = node?.alias ?? statement?.n ?? '';
  const league = node && snap?.leagues.find((l) => l.id === node.league);

  return (
    <section className="lg-intro lg-verify">
      <h1>SIGNED STATEMENT</h1>
      {!statement ? (
        <p className="lg-note">This link does not carry a statement.</p>
      ) : !snap ? (
        <div className="lg-wait">{error || 'LOADING THE RANKING…'}</div>
      ) : verdict === 'checking' ? (
        <div className="lg-wait">CHECKING…</div>
      ) : verdict === 'nokey' ? (
        <p className="lg-note">
          CANNOT BE CHECKED. Node {statement.n} has no key in the current ranking: it was not ranked in the
          last two seasons, or it left the ranking.
        </p>
      ) : verdict === 'invalid' ? (
        <p className="lg-note">NOT VALID. This statement was not signed with the key of node {who}.</p>
      ) : (
        <>
          <p className="lg-verify-ok">VALID</p>
          <blockquote className="lg-verify-says">{statement.s}</blockquote>
          <p>
            Signed with the key of node <a href={`#leagues/${statement.n}`}>{who}</a>, dated {statement.d} by
            the signer.
          </p>
          {node && season ? (
            <div className="lg-mine">
              <div className="lg-mine-head">
                <span className="lg-mine-name">{who}</span>
                <span className="lg-dim">
                  {(league?.title ?? `LEAGUE ${node.league}`).toUpperCase()} · SEASON OF {season.wk}
                  {season.final ? '' : ' · RUNNING'}
                </span>
              </div>
              <NodeCats node={node} cats={snap.categories} />
            </div>
          ) : (
            <p className="lg-dim">The node is not ranked in the running season.</p>
          )}
          <p className="lg-private">
            What this shows: the signer knows the first 8 characters of the node's telemetry GUID, of which
            the ranking publishes only the last 12. Relays a node connects to see its GUID as well. The check
            ran on this device; the statement was not sent to the server.
          </p>
        </>
      )}
    </section>
  );
}
