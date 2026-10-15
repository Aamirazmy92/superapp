const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * A Google search for `query`, as Chrome's address bar sends it. Google
 * localizes the results itself from the user's location and languages, as
 * it does in Chrome, so no region is forced on it.
 */
export function searchURL(query: string) {
  const params = new URLSearchParams({ q: query, sourceid: 'chrome', ie: 'UTF-8' });
  return `https://www.google.com/search?${params}`;
}

/**
 * Turns what was typed in the address bar into a page to open, like a
 * browser omnibox: URLs and host names open directly, anything else searches
 * Google. A bare host such as "node.js" may not exist, so it also returns the
 * search to fall back to if its name doesn't resolve.
 */
export function browserTarget(value: string): { url: string; fallback?: string } {
  const input = value.trim();
  if (!input) throw new Error('Enter an address or search term.');
  if (input.startsWith('?')) return { url: searchURL(input.slice(1).trim()) };
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const localInput = /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(input);
  const hostLike = /^[^\s/?#:@]+\.[a-z\d-]{2,}\.?(?::\d+)?(?:[/?#]\S*)?$/i.test(input);
  // Numbers such as "3.14" are searched, as in Chrome; only a full IPv4
  // address opens.
  const host = input.split(/[/?#:]/)[0];
  const numeric = /^[\d.]+$/.test(host) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (!hasScheme && !localInput && (!hostLike || numeric)) return { url: searchURL(input) };
  const url = new URL(hasScheme ? input : `${localInput ? 'http' : 'https'}://${input}`);
  const local = LOCAL_HOSTS.includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password)
    throw new Error('Use an HTTPS address or a local HTTP address.');
  return hasScheme || localInput ? { url: url.href } : { url: url.href, fallback: searchURL(input) };
}
