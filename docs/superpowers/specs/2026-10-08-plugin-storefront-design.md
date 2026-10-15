# Veyo plugin storefront — design

Status: approved in chat 2026-10-08 (catalog source, risk-based install, repo name, official logos).
Builds on `2026-10-08-plugins-design.md`.

## Goal

A public plugin storefront like ChatGPT's: a built-in catalog, browsable at once, with curated
sections, brand icons and one-click install, including first-party integrations for GitHub,
Supabase, Gmail and Google Drive.

## Decisions

- **Catalog**: `https://github.com/Aamirazmy92/veyo-plugins.git`, curated by the app owner. One
  constant in `electron/plugins/public.cjs`.
- **Built-in marketplace**: added automatically (not by user action) the first time Plugins opens,
  never at app start. Refreshed when older than 24 hours; refresh never installs or updates a
  plugin. It cannot be removed. This replaces the "marketplaces only by explicit action" rule for
  this one catalog; user-added marketplaces keep the old rule.
- **Install flow (risk-based)**: plugins whose contributions are only prompts, skills or themes
  install on "+" at once (user scope), with an Undo toast. Plugins with commands, agent presets or
  MCP servers open a compact sheet listing every command line and server, with an Install button
  and a link to the full review. Updates that add or change anything runnable always show it.
- **Logos**: each brand's official mark, used only to identify the service; every listing names
  the real provider ("by GitHub", "by Google"), and the catalog says it is listed by Veyo.

## Catalog format additions (all optional; Claude marketplaces keep working)

Top level: `sections: [{ id, title, plugins: [name…] }]` (≤ 10 sections, ≤ 50 names each).
Entry: `displayName` (≤ 60), `tagline` (≤ 80; falls back to the first sentence of `description`),
`icon` / `iconDark` (relative path inside the marketplace; `.svg`, `.png`, `.webp`; ≤ 256 KB),
`provider` (≤ 60, who makes the service), `setup`: `"none" | "sign-in" | "token" | "oauth-client"`
(a display hint for the row; behaviour comes from the manifest).

Icons are read by the main process (path checks, no links, size cap) and returned as `data:` URLs;
the renderer's CSP already allows `img-src data:`. SVGs render through `<img>`, which runs no script.

## MCP server `auth` (Veyo manifest extension)

```json
"auth": { "type": "oauth" }
"auth": { "type": "env", "variable": "GITHUB_PERSONAL_ACCESS_TOKEN", "url": "https://…", "label": "…" }
"auth": { "type": "oauth-client", "callbackPort": 8765, "setupUrl": "https://…", "clientIdPattern": "^…$" }
```

- `oauth`: the server supports dynamic client registration. After adding, Veyo offers
  **Sign in**, which runs `claude mcp login <name>` / `codex mcp login <name>` in a terminal.
- `env`: the server reads a token from an environment variable. Claude Code stores the literal
  `${VAR}` header and expands it at connect time (verified 2026-10-08 with a throwaway config);
  Codex uses `--bearer-token-env-var VAR`. Veyo shows whether the variable is set (a boolean from
  the process and user environment), never its value, and links to where to create the token.
- `oauth-client`: the user supplies their own OAuth client ID (validated against
  `clientIdPattern`), registered with redirect `http://localhost:<callbackPort>/callback`. Veyo runs
  `claude mcp add --transport http --client-id <id> --client-secret --callback-port <port> …`;
  Claude Code prompts for the secret with masked input in the visible terminal, so the secret never
  passes through Veyo. Codex would need the secret on its command line, so these servers are
  Claude Code only in v1.

## The four integrations

| Plugin | Server | auth | Clients |
|---|---|---|---|
| GitHub (by GitHub) | `https://api.githubcopilot.com/mcp/`, header `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` | env | Claude Code, Codex |
| Supabase (by Supabase) | `https://mcp.supabase.com/mcp` | oauth | Claude Code, Codex |
| Gmail (by Google, Developer Preview) | `https://gmailmcp.googleapis.com/mcp/v1` | oauth-client | Claude Code |
| Google Drive (by Google, Developer Preview) | `https://drivemcp.googleapis.com/mcp/v1` | oauth-client | Claude Code |

Each is a Veyo plugin in the catalog whose only contribution is its MCP server, plus a README
with setup steps and links to the provider's documentation.

## Install sheet for MCP plugins

Logo, name, provider; for each server: the coding CLIs to add it to (checkboxes, only installed
CLIs enabled), the exact command per CLI, and setup inputs (client ID) or status (token set / not
set). **Install** installs the plugin and opens one visible terminal per chosen CLI. Veyo records a
connection only when that terminal exits with code 0. Uninstalling offers to remove recorded
connections (`claude mcp remove <name> -s <scope>` / `codex mcp remove <name>`), again in a terminal.

## Storefront UI

Header: title, subtitle, search, refresh, a settings button (marketplace management) and an
**Add** menu (From folder…, From Git address…, Add marketplace…). Tabs **Public** and **Personal**.

- Public: the built-in catalog's sections in order, then "All plugins"; two-column rows with a
  40px icon tile, name, tagline, and an action: **+** (install), a person icon for `setup` other
  than `none` (opens the sheet), a spinner while working, **…** once installed (Details, Disable,
  Uninstall), an update dot when newer. Search flattens all marketplaces into one list.
- Personal: installed plugins (same rows with the on/off switch) and plugins from user-added
  marketplaces.
- Row click opens details. Rows without an icon get a monogram tile.

## Seed catalog

Popular: GitHub, Supabase, Gmail, Google Drive, commit-commands, frontend-design.
New & Noteworthy: Git Essentials, Review Prompts, Theme Pack, Agent Presets, code-review,
feature-dev, pr-review-toolkit. Anthropic's plugins are referenced by `git-subdir` pinned to a
commit of `anthropics/claude-plugins-official`, shown with Anthropic's Claude mark.

## Testing

Unit: catalog additions (sections, icons, taglines, bad icon paths and sizes), risk
classification, `auth` validation and the CLI arguments for each type, built-in marketplace
(auto-add, cannot remove, staleness), connections recorded only on exit code 0.
Electron: a local copy of the catalog as the built-in source (env override for tests only):
Public sections, instant install + Undo of a prompts-only plugin, the sheet for an MCP plugin
(commands shown, CLI checkboxes), Personal tab, search.
Manual: the real catalog over the network once published; one real `claude mcp add` for Supabase
and its removal.
