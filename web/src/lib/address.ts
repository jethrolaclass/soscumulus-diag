/**
 * Address lookup against the Base Adresse Nationale.
 *
 * `api-adresse.data.gouv.fr` is the French state's own address service: no key,
 * no quota to negotiate, no third-party script, and the client's home address
 * never leaves French public infrastructure. A commercial autocomplete would
 * have cost a hundred kilobytes of script on a page that budgets eleven, and
 * sent every keystroke of a private address to an advertising company.
 *
 * Nothing here is required: the field is an ordinary text input, and a failed
 * or empty lookup leaves whatever the client typed. In a cellar with no signal,
 * a hand-typed address is still an address.
 */

const ENDPOINT = 'https://api-adresse.data.gouv.fr/search/';

/** Below three characters the service returns noise rather than candidates. */
const MIN_QUERY = 3;

export interface AddressHit {
  /** Ready to read aloud: "12 Rue de la Paix 69003 Lyon". */
  label: string;
  /** `housenumber` is a doorstep; `street` or `municipality` is not. */
  precise: boolean;
}

export async function searchAddress(
  query: string,
  signal?: AbortSignal,
): Promise<AddressHit[]> {
  if (query.trim().length < MIN_QUERY) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');
  url.searchParams.set('autocomplete', '1');

  const res = await fetch(url, { signal });
  if (!res.ok) return [];

  const body = (await res.json()) as {
    features?: Array<{ properties?: { label?: string; type?: string } }>;
  };

  return (body.features ?? [])
    .map((f) => ({
      label: f.properties?.label ?? '',
      precise: f.properties?.type === 'housenumber',
    }))
    .filter((hit) => hit.label !== '');
}
