/** Matching for the Settings search box. */

/** Lowercase words with accents and punctuation removed ("Ctrl + `" becomes "ctrl"). */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when the strings differ by at most one insertion, deletion or substitution. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length || i === b.length) return true;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function tokenMatches(token: string, words: string[]): boolean {
  if (words.some((word) => word.startsWith(token))) return true;
  // A slip in a long word ("scrolback"); shorter words would match unrelated ones.
  return token.length >= 6 && words.some((word) => word.length >= 6 && withinOneEdit(token, word));
}

/** Whether the words, run together from some word onward, start with the text ("wordwrap"). */
function startsRunTogether(words: string[], joined: string): boolean {
  return words.some((_, i) => words.slice(i).join('').startsWith(joined));
}

/**
 * Whether a setting matches the query. Every word of the query must match somewhere in the
 * setting's text, in any order, by being the start of a word: "redu" finds "Reduce motion" but
 * not "Returning". A long word with one typo also matches. An empty query matches everything.
 */
export function matchesSearch(query: string, ...fields: string[]): boolean {
  const tokens = searchWords(query);
  if (!tokens.length) return true;
  const words = searchWords(fields.join(' '));
  // "wordwrap" should find "Word wrap".
  if (tokens.length === 1 && startsRunTogether(words, tokens[0])) return true;
  return tokens.every((token) => tokenMatches(token, words));
}
