const path = require('node:path');

/** Veyo's public plugin catalog, built into the app. */
const PUBLIC_CATALOG = 'https://github.com/Aamirazmy92/veyo-plugins.git';

/*
 * Development builds may point the built-in catalog at a local folder for tests
 * (VEYO_PUBLIC_CATALOG). Packaged builds always use the public repository, as
 * they ignore VEYO_DEV_URL.
 */
function publicCatalogSource(isPackaged, override) {
  if (!isPackaged && typeof override === 'string' && override && path.isAbsolute(override)) return override;
  return PUBLIC_CATALOG;
}

module.exports = { PUBLIC_CATALOG, publicCatalogSource };
