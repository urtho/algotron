import type { RankNode, RankSeason } from '../../shared/types.ts';

/** Where the visitor's own nodes are remembered: on this device only, never sent anywhere */
export const ME_KEY = 'algotron.rank.me';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/;
const ID = /^[0-9a-f]{12}$/;

/**
 * What a visitor typed, turned into what the snapshot can be searched for: a telemetry GUID or its last 12
 * characters give the public ID, anything else is taken as an alias (with or without the leading @).
 * This runs in the browser; the text is not sent to the server.
 */
export function parseQuery(input: string): { id?: string; alias?: string } {
  const text = input.trim().toLowerCase();
  if (!text) return {};
  const guid = GUID.exec(text);
  if (guid) return { id: guid[1] };
  if (ID.test(text)) return { id: text };
  return { alias: text.replace(/^(@|::\s*)/, '') };
}

export function findNode(
  season: RankSeason | undefined,
  q: { id?: string; alias?: string },
): RankNode | undefined {
  if (!season) return undefined;
  if (q.id) return season.nodes.find((n) => n.id === q.id);
  if (q.alias) return season.nodes.find((n) => n.alias?.toLowerCase() === q.alias);
  return undefined;
}

/** 1 = top tenth of the league, 2 = top quarter, 3 = top half, 4 = the rest */
export function band(rank: number, field: number): 1 | 2 | 3 | 4 {
  const share = rank / Math.max(1, field);
  return share <= 0.1 ? 1 : share <= 0.25 ? 2 : share <= 0.5 ? 3 : 4;
}
export const BAND_TEXT = ['', 'top 10%', 'top 25%', 'top half', 'lower half'];

/** Whole years a node has been reporting: the tenure milestone it holds (0 = under a year) */
export const tenureYears = (days: number) => Math.floor(days / 365);

export function tenureText(days: number): string {
  const y = Math.floor(days / 365);
  return y > 0 ? `${y}y ${days - y * 365}d` : `${days}d`;
}

export function loadMine(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ME_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export function saveMine(ids: string[]): void {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(ids));
  } catch {
    // the pin then lasts for this visit only
  }
}
