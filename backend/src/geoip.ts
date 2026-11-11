export interface Geo {
  lat: number;
  lng: number;
  country: string;
  countryCode: string;
  city: string;
  net: string;
}

const EMPTY: Geo = { lat: 0, lng: 0, country: '', countryCode: '', city: '', net: '' };
const cache = new Map<string, Geo>();

interface IpApiRow {
  status?: string;
  lat?: number;
  lon?: number;
  country?: string;
  countryCode?: string;
  city?: string;
  as?: string;
  query?: string;
}

/** "AS16276 OVH SAS" -> "OVH" */
function netName(as: string | undefined): string {
  if (!as) return '';
  const words = as.replace(/^AS\d+\s*/, '').split(/[\s,]+/);
  return (words[0] ?? '').replace(/\.$/, '');
}

/**
 * Batch lookup at ip-api.com (free, no key, 100 addresses per request).
 * Answers are cached for the life of the process; a failed lookup is not
 * cached, so the next discovery run tries again.
 */
export async function geolocate(ips: string[]): Promise<Map<string, Geo>> {
  const out = new Map<string, Geo>();
  const missing = ips.filter((ip) => !cache.has(ip));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await fetch(
        'http://ip-api.com/batch?fields=status,lat,lon,country,countryCode,city,as,query',
        {
          method: 'POST',
          body: JSON.stringify(chunk.map((query) => ({ query }))),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) throw new Error(`ip-api.com ${res.status}`);
      for (const row of (await res.json()) as IpApiRow[]) {
        if (!row.query || row.status !== 'success') continue;
        cache.set(row.query, {
          lat: row.lat ?? 0,
          lng: row.lon ?? 0,
          country: row.country ?? '',
          countryCode: row.countryCode ?? '',
          city: row.city ?? '',
          net: netName(row.as),
        });
      }
    } catch (err) {
      console.warn(`[GEO] lookup failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const ip of ips) out.set(ip, cache.get(ip) ?? EMPTY);
  return out;
}
