interface GeoResult {
  lat: number;
  lng: number;
  country: string;
  countryCode: string;
  city: string;
}

interface IpApiResponse {
  status: string;
  lat?: number;
  lon?: number;
  country?: string;
  countryCode?: string;
  city?: string;
  query?: string;
}

/** Process-lifetime cache — survives across WebSocket sessions. */
const geoCache = new Map<string, GeoResult>();

/**
 * Batch geolocate a list of IP addresses using ip-api.com free endpoint.
 * Results are cached for the lifetime of the backend process.
 * Returns a map from IP to geo data. Falls back to 0,0 on failure.
 */
export async function geolocateIPs(ips: string[]): Promise<Map<string, GeoResult>> {
  const result = new Map<string, GeoResult>();

  if (ips.length === 0) return result;

  // Serve cached entries immediately; collect only the misses
  const uncached: string[] = [];
  for (const ip of ips) {
    const hit = geoCache.get(ip);
    if (hit) {
      result.set(ip, hit);
    } else {
      uncached.push(ip);
    }
  }

  if (uncached.length === 0) return result;

  // ip-api.com allows up to 100 per batch request
  const chunks: string[][] = [];
  for (let i = 0; i < uncached.length; i += 100) {
    chunks.push(uncached.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const response = await fetch('http://ip-api.com/batch?fields=status,lat,lon,country,countryCode,city,query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(ip => ({ query: ip }))),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`ip-api.com returned ${response.status}`);
      }

      const data = await response.json() as IpApiResponse[];

      for (const entry of data) {
        const ip = entry.query ?? '';
        const geo: GeoResult = {
          lat: entry.lat ?? 0,
          lng: entry.lon ?? 0,
          country: entry.country ?? '',
          countryCode: entry.countryCode ?? '',
          city: entry.city ?? '',
        };
        geoCache.set(ip, geo);
        result.set(ip, geo);
      }
    } catch (_err) {
      // Fallback: store 0,0 so we don't hammer the API on retry
      for (const ip of chunk) {
        if (!result.has(ip)) {
          const fallback: GeoResult = { lat: 0, lng: 0, country: '', countryCode: '', city: '' };
          geoCache.set(ip, fallback);
          result.set(ip, fallback);
        }
      }
    }
  }

  // Safety net: guarantee every requested IP has an entry
  for (const ip of ips) {
    if (!result.has(ip)) {
      const fallback: GeoResult = { lat: 0, lng: 0, country: '', countryCode: '', city: '' };
      geoCache.set(ip, fallback);
      result.set(ip, fallback);
    }
  }

  return result;
}
