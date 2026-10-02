const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function searchURL(query: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
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
  if (!hasScheme && !localInput && !hostLike) return { url: searchURL(input) };
  const url = new URL(hasScheme ? input : `${localInput ? 'http' : 'https'}://${input}`);
  const local = LOCAL_HOSTS.includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password)
    throw new Error('Use an HTTPS address or a local HTTP address.');
  return hasScheme || localInput ? { url: url.href } : { url: url.href, fallback: searchURL(input) };
}
