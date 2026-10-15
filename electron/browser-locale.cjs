// What the built-in browser tells sites about the user, so they see it the
// way they would see Chrome on this computer: Chrome's user agent and the
// language and region chosen in the operating system.

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i;
const MAX_LANGUAGES = 8;

/**
 * The language list Chrome builds from these languages: each regional
 * language is followed by its base language (unless the user listed it), so
 * ['en-GB', 'en-US'] becomes "en-GB,en-US,en". Chromium weights the list
 * when it sends it, as "en-GB,en-US;q=0.9,en;q=0.8".
 */
function acceptLanguages(languages) {
  const tags = [];
  for (const value of languages) {
    if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) continue;
    const tag = value.replace(/_/g, '-');
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    if (tags.length === MAX_LANGUAGES) break;
  }
  if (!tags.length) tags.push('en-US');
  const listed = new Set(tags.map((tag) => tag.toLowerCase()));
  const expanded = [];
  tags.forEach((tag, index) => {
    expanded.push(tag);
    const base = tag.split('-')[0].toLowerCase();
    const next = tags[index + 1]?.split('-')[0].toLowerCase();
    // The base goes after the last of a run of the same language.
    if (next !== base && !listed.has(base)) {
      expanded.push(base);
      listed.add(base);
    }
  });
  return expanded.join(',');
}

/**
 * Chrome's user agent for this platform. Like Chrome, only the major version
 * is given; Electron's and the app's own tokens are left out, since sites
 * such as Google sign-in turn embedded browsers away.
 */
function chromeUserAgent(platform, chromeVersion) {
  const major = String(chromeVersion).split('.')[0];
  const system =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

module.exports = { acceptLanguages, chromeUserAgent };
