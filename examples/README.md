# Plugin examples

`marketplace/` is a sample Veyo marketplace. It is used by the tests and serves as documentation; it is not bundled into the app.

- `plugins/hello-veyo`: a valid plugin with two commands, an agent preset, a prompt, a skill, an MCP server and a theme.
- `plugins/evil-traversal`: invalid on purpose. Its prompts path climbs out of the plugin folder.
- `plugins/evil-bypass`: invalid on purpose. Its agent preset tries to skip approval prompts.

To try it, open **Plugins → Marketplaces** in Veyo and add the full path of the `marketplace` folder. The format is described in [docs/plugins.md](../docs/plugins.md).
