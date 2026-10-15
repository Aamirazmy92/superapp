# Writing Veyo plugins

A Veyo plugin is a folder with a manifest. It can add:

- **commands** that run a program in a new, visible terminal in the open project (Ctrl+K and **Run command**);
- **agent presets**: extra entries in the agent pickers that start a coding CLI with fixed arguments;
- **prompts and skills**: Markdown text the user can copy, put into a chat draft, or type into an agent;
- **MCP server definitions** that the user can add to Claude Code or Codex;
- **themes** for the workspace, editor and terminal.

Plugins cannot run code inside Veyo, change its interface, or react to events in the background. Nothing a plugin contains runs when it is installed.

The example in [`examples/marketplace`](../examples/marketplace) shows every piece. The JSON Schemas are in [`docs/schemas`](schemas).

## Layout

```
my-plugin/
  .veyo-plugin/plugin.json   manifest (required)
  README.md                  shown in Plugins → details
  scripts/…                  files your commands run
  prompts/*.md               prompt templates
  skills/<name>/SKILL.md     skills
  .mcp.json                  MCP servers (Claude Code format)
  themes/*.json              themes
```

### Claude Code plugins

A folder with `.claude-plugin/plugin.json` and no Veyo manifest is imported as is. Veyo reads its `commands/*.md` as prompts, `skills/*/SKILL.md` as skills, and `.mcp.json` (or `mcpServers`) as MCP servers. Hooks, agents, output styles and LSP servers are listed in the plugin's details as "not used by Veyo". When the manifest has no semantic version, the plugin is versioned by the first 12 characters of its commit sha (or `local-<content hash>` for folders), as Claude Code does.

To give a Claude Code plugin Veyo commands or themes, add a `.veyo-plugin/plugin.json` beside the Claude manifest. Veyo then reads only the Veyo manifest.

## Manifest

```json
{
  "name": "acme-tools",
  "version": "1.2.0",
  "description": "Lint and review helpers for Acme projects.",
  "author": { "name": "Acme" },
  "license": "MIT",
  "homepage": "https://example.com/acme-tools",
  "minAppVersion": "0.1.0",
  "contributes": {
    "commands": [
      { "id": "lint", "title": "Lint project", "run": { "program": "npx", "args": ["eslint", "."] } },
      { "id": "report", "title": "Write report", "run": { "program": "node", "args": ["${pluginRoot}/scripts/report.mjs", "${projectRoot}"] } }
    ],
    "agents": [
      { "id": "claude-sonnet", "label": "Claude · Sonnet", "program": "claude", "args": ["--model", "sonnet"], "mark": "S" }
    ],
    "prompts": "./prompts",
    "skills": "./skills",
    "mcpServers": "./.mcp.json",
    "themes": [{ "id": "dusk", "label": "Dusk", "path": "./themes/dusk.json" }]
  }
}
```

| Field | Rules |
|---|---|
| `name` | Lowercase letters, digits and single hyphens; up to 64 characters. |
| `version` | Semantic version, such as `1.2.0`. |
| `minAppVersion` | Optional. Older Veyo versions refuse to install the plugin, and keep it inactive if it is already installed. |
| ids | Every command, agent, theme id: the same rule as `name`, unique within its kind. |

A plugin is identified as `name@marketplace` (`name@local` for a folder, `name@git` for a Git address). Contributions are namespaced by plugin name (`acme-tools:lint`), and two installed plugins cannot share a name.

## Commands and agent presets

`program` is either:

- a command name found on `PATH`, such as `node`, `git` or `npx` (never a file in the user's project); or
- `${pluginRoot}/path/inside/plugin`. On Windows this must be an `.exe`, `.cmd`, `.bat` or `.ps1` file. To run a JavaScript or Python file, use `node` or `python` as the program and pass the file as an argument.

`args` is a list of separate arguments. They are never joined into a shell command, so pipes, `&&` and redirection do not work; put those in a script. Two placeholders are replaced in arguments:

- `${pluginRoot}`: the installed plugin folder;
- `${projectRoot}`: the open project folder.

Commands run with the project folder as their working directory.

Arguments are refused if they contain:

- control characters, including line breaks, or double quotes (`"`);
- for `.cmd` and `.bat` programs: `% ! ^ & | < >`, which `cmd.exe` cannot pass safely. Veyo checks again after replacing the placeholders, so a project path containing `%` stops a `.cmd` command from running.

Agent presets may not change how an agent asks for approval. Veyo refuses presets with flags such as `--dangerously-skip-permissions`, `--permission-mode`, `--yolo`, `--full-auto`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--allowed-tools`, `--force` or `-y`, and any argument mentioning "bypass", "yolo", "dangerous", "skip-permission", "auto-approve" or "full-access".

## Prompts and skills

Prompts are Markdown files in Claude Code's command format:

```markdown
---
description: Ask an agent to review the current diff
---
Review the uncommitted changes in this repository…
```

The file name (without `.md`) is the prompt id. Skills are folders containing `SKILL.md` with `name` and `description` in the frontmatter. Veyo shows the text before it goes anywhere, and never submits it: it is copied, placed in a chat draft, or typed into an agent without pressing Enter. Control characters are removed before text is typed into a terminal.

## MCP servers

Use Claude Code's `.mcp.json` format, either `{ "mcpServers": { … } }` or the servers object directly:

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@acme/docs-mcp"], "env": { "DOCS_DIR": "${CLAUDE_PLUGIN_ROOT}/docs" } },
    "remote": { "type": "http", "url": "https://mcp.example.com/mcp" }
  }
}
```

Veyo does not start MCP servers. When a plugin with MCP servers is installed (and later in its details), Veyo shows the exact `claude mcp add …` / `codex mcp add …` command for each coding CLI that is installed, and runs the chosen ones in visible terminals. The server is named after the plugin when they share a name, otherwise `<plugin>-<server>`. `${CLAUDE_PLUGIN_ROOT}` and `${pluginRoot}` become the installed plugin folder. Veyo records a server as added only when the CLI's command exits successfully, and offers to remove it again when the plugin is uninstalled.

### Signing in to remote servers

A Veyo manifest can describe how a remote (`http`/`sse`) server signs in, so Veyo can offer the right next step:

```json
"github": {
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
  "auth": { "type": "env", "variable": "GITHUB_PERSONAL_ACCESS_TOKEN", "url": "https://github.com/settings/personal-access-tokens/new", "label": "GitHub personal access token" }
}
```

| `auth.type` | Meaning | What Veyo does |
|---|---|---|
| `oauth` | The server supports browser sign-in with dynamic client registration. | Offers **Sign in** (`claude mcp login <name>`) after adding. Codex signs in by itself while adding. |
| `env` | The CLI reads a token from an environment variable (`variable`), referenced as `${VARIABLE}` in a header. | Shows whether the variable is set (never its value) and links to `url`. Claude Code stores the `${VARIABLE}` reference and reads the value when it connects; Codex gets `--bearer-token-env-var VARIABLE`. |
| `oauth-client` | The person must bring their own OAuth client (`callbackPort`, `setupUrl`, optional `clientIdHint`). | Asks for the client ID and runs `claude mcp add --client-id … --client-secret --callback-port …`; Claude Code asks for the secret with masked input in its terminal, so Veyo never sees it. The redirect URI to register is `http://localhost:<callbackPort>/callback`. Codex is not offered (it needs the secret on its command line). |

Codex supports neither SSE servers nor headers other than `Authorization: Bearer ${VARIABLE}` from its command line.

## Themes

```json
{
  "base": "midnight",
  "colors": {
    "chrome": "#15121c", "stage": "#1c1826", "well": "#17141f", "raised": "#272233",
    "accent": "#f2a65a", "foreground": "#ece6f5", "muted": "#a59cb5",
    "selection": "#4a3d63", "keyword": "#c9a0ff", "string": "#a8d8a0"
  }
}
```

`base` is one of `graphite`, `midnight`, `plum`, `light`; it provides every colour the theme does not set. All colours must be `#rrggbb`. When the plugin is disabled or removed, the user's built-in theme returns.

## Marketplaces

A marketplace is a Git repository or folder with `.veyo-plugin/marketplace.json` (Claude Code's `.claude-plugin/marketplace.json` is read too):

```json
{
  "name": "acme",
  "owner": { "name": "Acme" },
  "plugins": [
    { "name": "acme-tools", "version": "1.2.0", "source": "./plugins/acme-tools", "category": "development", "tags": ["lint"] },
    { "name": "acme-remote", "source": { "source": "github", "repo": "acme/remote-plugin", "ref": "v2.0.0" } },
    { "name": "acme-sub", "source": { "source": "git-subdir", "url": "https://github.com/acme/mono.git", "path": "plugins/sub", "sha": "0123456789abcdef0123456789abcdef01234567" } }
  ]
}
```

- Storefront fields (optional): `displayName`, `tagline` (one line, at most 80 characters; otherwise the first sentence of `description`), `provider` (who makes the service), `icon` and `iconDark` (an `.svg`, `.png` or `.webp` file inside the marketplace, at most 256 KB; `iconDark` is used on dark themes), and `setup` (`none`, `sign-in`, `token` or `oauth-client`: what the person must do before the plugin works, shown as the row's action). At the top level, `sections: [{ "id": "popular", "title": "Popular", "plugins": ["name", …] }]` lists curated rows; every valid plugin also appears under "All plugins".
- Sources: a relative folder inside the marketplace; `github` (`owner/repo`); `url` (an https or ssh Git address); `git-subdir` (a folder inside a Git repository). `ref` picks a branch or tag; `sha` pins a full commit. npm sources are not supported.
- The entry `name` is the name Veyo installs the plugin under, even if the plugin's manifest uses a different name.
- An entry that fails validation is listed with its error; the rest of the catalog still works.
- Updates are detected when the marketplace is refreshed: a higher `version` in the entry (or, for relative sources, in the plugin's manifest), otherwise a different commit. Veyo never updates a plugin on its own.

Veyo's own catalog, [Aamirazmy92/veyo-plugins](https://github.com/Aamirazmy92/veyo-plugins), is built in: it is downloaded the first time Plugins is opened and refreshed daily, and it cannot be removed. Users add other marketplaces themselves, as `owner/repo`, an https or ssh Git address, or a folder path.

## Installing

Plugins whose only contributions are prompts, skills or themes install with one click (and can be undone from the notification). Plugins with commands, agent presets or MCP servers open a sheet that lists every command line and the exact MCP commands first; **Full details** opens the complete review.

## Limits and checks

- Manifest up to 256 KB; any file up to 1 MB; up to 2,000 files and 50 MB per plugin; folders up to 16 levels deep; up to 50 contributions of each kind; marketplace index up to 4 MB and 1,000 entries.
- Links of any kind (symbolic links, junctions) are refused. Paths in the manifest must be relative and stay inside the plugin.
- Git repositories are cloned shallowly, without submodules, hooks, filesystem monitors, credential prompts or symbolic links, with a 60-second limit.

## Testing a plugin

In Veyo, open **Plugins → Installed → Install from folder…** and choose your plugin folder. The review screen shows exactly what Veyo read, or the first error it found. After changing the folder, choose **Check for update** in the plugin's details to review and install the new copy.
