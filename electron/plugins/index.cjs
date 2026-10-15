// The plugin system: manifest validation, registry, installs and contributions.
module.exports = {
  ...require('./service.cjs'),
  ...require('./manifest.cjs'),
  ...require('./registry.cjs'),
};
