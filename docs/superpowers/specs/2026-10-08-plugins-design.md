# Veyo plugins — design

Status: approved 2026-10-08 (format check-in; user delegated remaining choices).

## Goal

A plugin is a folder with a manifest that adds commands, agent presets, prompts/skills,
MCP server definitions and themes to Veyo. A marketplace is a catalog of plugins (Git repo
or local folder). Users add marketplaces, install, enable/disable, update and uninstall
plugins from a Plugins section, with an explicit consent step before anything is installed.

Out of scope for v1 (deferred to v2): hooks, plugin JavaScript in the renderer or main process, UI
injection, hosted services, npm sources, automatic updates, writing plugin files into a
project repository.

## Prior art copied

- Claude Code: `.claude-plugin/plugin.json`, convention directories (`commands/*.md`,
  `skills/<name>/SKILL.md`, `.mcp.json`), `.claude-plugin/marketplace.json` with
  `source` = relative path | `{source:"url",url,ref?,sha?}` | `{source:"github",repo,ref?,sha?}`
  | `{source:"git-subdir",url,path,ref?,sha?}`, identity `name@marketplace`, registry
  entries with `scope` user/project, `version` falling back to a 12-char sha, cache at
  `cache/<marketplace>/<plugin>/<version>`.
- Codex: same identity and cache layout; enable state kept apart from install records.

## Manifest

`<plugin>/.veyo-plugin/plugin.json`; if absent, `.claude-plugin/plugin.json` is imported.

| field | rule |
|---|---|
| `name` | required, `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 |
| `version` | semver; optional for imported Claude plugins (falls back to source sha or content hash) |
| `description` | string ≤ 1000 |
| `author` | string or `{name, email?, url?}` |
| `license`, `homepage` | strings; homepage must be http(s) |
| `minAppVersion` | semver; install refused and contributions withheld when newer than the app |
| `contributes` | see below; for imported Claude plugins inferred from convention directories |

`contributes`:

- `commands`: `[{id, title, description?, run: {program, args?: string[]}}]`
- `agents`: `[{id, label, program, args?: string[], mark?}]`
- `prompts`: relative directory of `*.md` (Claude command format; frontmatter `description`)
- `skills`: relative directory of `<name>/SKILL.md` (frontmatter `name`, `description`)
- `mcpServers`: relative path to a JSON file `{name: {command,args?,env?} | {type:"http"|"sse", url, headers?}}`
  (or `{mcpServers:{...}}`, as Claude allows)
- `themes`: `[{id, label, path}]`; theme file `{base: "graphite"|"midnight"|"plum"|"light", colors: {chrome, stage, well, raised, accent, foreground, muted, selection, keyword, string}}`, each `#rrggbb`

Contribution ids: `^[a-z0-9]+(-[a-z0-9]+)*$`. Namespaced key: `<plugin>:<id>`. At most 50 of each kind.

### Program and argument rules (commands and agents)

- `program` is either a bare executable name (`^[A-Za-z0-9._-]+$`, resolved only from PATH,
  never from the project) or `${pluginRoot}/<relative path>` to a file inside the plugin.
- `args` are a string array; `${pluginRoot}` and `${projectRoot}` are the only substitutions.
- Reject control characters and `"` in args. When the resolved program is `.cmd`/`.bat`,
  also reject `% ! ^ & | < >` (cmd.exe cannot quote these safely); checked again at run time
  after substitution.
- Agent presets reject approval-changing flags: `--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--permission-mode`, `--yolo`, `--full-auto`,
  `--sandbox`, `-s`, `--ask-for-approval`, `-a`, `--approval-mode`, `--allow-all-tools`,
  `--trust`, `--auto-approve`, and anything matching `/bypass|yolo|skip-permission|auto-?approve/i`.

### Limits

Manifest ≤ 256 KB; any file ≤ 1 MB; ≤ 2,000 files and ≤ 50 MB per plugin; directory depth ≤ 16.
Symlinks/junctions anywhere in the plugin are rejected. All referenced paths must be relative,
must not contain `..`, and must resolve (realpath) inside the plugin root.

## Marketplace

`<repo>/.veyo-plugin/marketplace.json`, falling back to `.claude-plugin/marketplace.json`:
`{name, owner: {name}, description?, plugins: [{name, description?, version?, source, category?, tags?, author?, homepage?}]}`.
Marketplace name follows the plugin-name rule; `local` and `git` are reserved. Invalid entries
are listed with their error instead of failing the whole catalog. Max 1,000 entries, 4 MB.

Added by explicit user action only, as a Git URL (`https://`, `ssh://`, `git@`), `owner/repo`
(GitHub), or a local absolute folder path. Git marketplaces are shallow-cloned under
`plugins/marketplaces/<name>`; refresh re-clones to a temp dir and swaps. Local marketplaces are
read in place.

## Storage

`<userData>/plugins/`:

- `installed.json` — `{version: 1, plugins: [{id, name, marketplace, scope, projectId?, version,
  sha?, source, installPath, installedAt, lastUpdated, enabled}], marketplaces: [{name, source,
  addedAt, lastUpdated, sha?}]}` written with the existing atomic write helper.
- `cache/<marketplace>/<name>/<version>/` — installed plugin files.
- `marketplaces/<name>/` — Git marketplace clones.
- `staging/<uuid>/` — previews awaiting consent; removed on install, cancel, and start-up.

Scope: `user` applies to every project; `project` applies when `projectId` is the active project.
The same plugin may be installed once per scope; when both apply, the project install wins.
Plugin names are unique across marketplaces: installing `x@b` while `x@a` exists is refused.
Project-scoped installs are removed when their project is removed from Veyo.

## Lifecycle

1. **Preview**: resolve the source (marketplace entry, Git URL, or local folder), copy/clone into
   `staging/<uuid>`, reject symlinks, enforce limits, validate the manifest, resolve the commit sha.
   Returns the full plugin description and a preview id. Nothing is executed (no install scripts).
2. **Consent**: the renderer shows source, sha, author, scope, every command (program + args),
   every agent preset, every MCP server, prompts, skills and themes.
3. **Install(previewId, scope, projectId)**: rename the staging dir into the cache, write the
   registry entry, emit `plugins:changed`.
4. **Enable/disable**: flips `enabled`, emits `plugins:changed`; contributions recompute immediately.
5. **Update**: preview of the newer source, shown as a diff (version, sha, added/removed/changed
   commands, agents and MCP servers); confirm replaces the entry and deletes the old cache dir.
   Updates are detected on marketplace refresh only (entry version or sha differs from installed).
6. **Uninstall**: after confirmation, remove the registry entry, then the cache dir when no other
   entry uses it.

Every load re-validates the installed files; a plugin that fails validation shows an error and
contributes nothing. Start-up removes cached folders no install refers to (skipped when the registry
was unreadable and set aside). As in Claude Code, a marketplace entry's name wins over the plugin
manifest's own name; the consent view shows both.

## Git

System `git` via `execFile` with an argument array, `timeout: 60s`, env `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, `GIT_ASKPASS=`, `SSH_ASKPASS=`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`,
config `-c core.fsmonitor= -c core.hooksPath=<nonexistent> -c protocol.file.allow=never -c protocol.ext.allow=never`.
`clone --depth 1 --no-recurse-submodules --single-branch [--branch ref] -- <url> <dir>`; with a
pinned sha, `fetch --depth 1 origin <sha>` and `checkout --detach <sha>`; `rev-parse HEAD` records
the sha. `.git` is deleted from the staged copy. Missing `git` → "Git is not installed" state.
URLs must be `https:`, `ssh:`, `git@host:path`, or a GitHub shorthand; `ext::`, `file:` and
option-like values are rejected.

## Contributions in the app

- **Commands** appear in Ctrl+K (label, "from <plugin>") and in Run command under "Plugin commands".
  Running one opens a new visible terminal in the active project, spawned directly with the
  resolved program and argument array (same code path as agent launch). Renderer sends only the
  namespaced key; main resolves everything.
- **Agent presets** are returned by `agents:list` with id `plugin:<plugin>:<id>` and `source`;
  they appear in the launcher and new-pane menu with "from <plugin>", and launch through
  `agents:launch`. They never touch approval settings.
- **Prompts/skills** appear in Ctrl+K as "Prompt: <title>"; choosing one opens a preview with Copy,
  Insert into chat, and Type into active terminal (no Enter).
- **MCP servers** are listed in plugin details with "Add to Claude Code" / "Add to Codex". After a
  confirmation showing the exact command, a visible terminal runs `claude mcp add` /
  `codex mcp add` with an argument array. Veyo never edits those CLIs' config files.
- **Themes** appear in Settings → Appearance with "from <plugin>". They are stored in a separate
  `pluginTheme` preference (`<plugin>:<id>`); when the plugin is unavailable the user's built-in
  `theme` applies again (rather than always Ember).

## IPC (preload `window.workspace`)

`pluginsState(projectId?)`, `pluginsCatalog()`, `pluginsAddMarketplace(input)`,
`pluginsRefreshMarketplace(name)`, `pluginsRemoveMarketplace(name)`, `pluginsPreview(request)`,
`pluginsPickFolder()`, `pluginsCancelPreview(id)`, `pluginsInstall(previewId, scope, projectId?)`,
`pluginsSetEnabled(key, enabled)`, `pluginsUninstall(key)`, `pluginsContributions(projectId?)`,
`pluginsRunCommand(projectId, commandKey, workspaceName)`, `pluginsAddMcp(projectId, pluginKey,
server, cli)`, `pluginsReadme(key)`, `onPluginsChanged(cb)`. All arguments are type- and
length-checked in main; all requests go through the existing sender check.

## UI

`Plugins` modal (Settings nav entry + Ctrl+K "Plugins"), tabs Installed / Discover / Marketplaces,
built from `Modal`, `Switch`, toasts and tokens. States: empty, loading, offline/git errors (real
message), git missing, invalid manifest, install failure, update available, incompatible
`minAppVersion`. Details view renders README through `MarkdownMessage` (links open only via the
existing `openExternal` validation).

## Testing

- `tests/plugins.test.cjs`: manifest validation (traversal, absolute paths, symlinks, oversized,
  bad names, bypass flags), Claude import, registry atomicity and scope resolution, namespacing
  and collisions, marketplace parsing, update detection, staging/install/uninstall on a temp dir.
- `tests/plugins.electron.cjs`: local-folder marketplace from `examples/`, install, command in
  Ctrl+K, disable, uninstall, malicious plugin rejected; no network.
