# Security review — 26 September 2026

This review covered the Electron main process and preload bridge, renderer content, project file and Git operations, local chat/preview endpoints, dependency advisories, and the Windows package. It is a review of this codebase and build, not a guarantee against every future vulnerability.

## Fixed

- Packaged builds ignore `VEYO_DEV_URL`. Development builds accept only a root URL on `127.0.0.1` with an explicit port. The package smoke test supplies a hostile URL and verifies that the local `file://` UI still loads.
- Automatic Git status calls disable repository-configured `core.fsmonitor` commands. A test first proves that Git would execute the configured command, then proves that the app's status call does not.
- Workspace state files are created with owner-only POSIX modes. Existing Windows access control is inherited from the user-data directory.
- Electron is pinned to 44.4.5 in the dependency lockfile and package configuration. The package command refuses to use an older or incomplete locally installed Electron binary.
- The Windows package disables `NODE_OPTIONS` and Node inspector arguments, and enables ASAR integrity validation and ASAR-only app loading. `runAsNode` stays enabled because `node-pty` uses `child_process.fork()` during terminal shutdown.
- The package smoke test uses Chromium's debugging protocol because the Node inspector is disabled in the release binary.

## Verification

- `npm test`: 21 passing tests in a clean isolated install.
- `npm run package`: production build and Windows package succeeded in the isolated install.
- `npm audit`: zero reported advisories across production and development dependencies on this date.
- The Electron 44.4.5 archive matched the SHA-256 in Electron's published `SHASUMS256.txt`.
- The packaged app launched, opened its local UI despite an injected development URL, ran and closed a terminal, and loaded agent chat controls.
- Fuse states were read from the final packaged executable.

The verified executable from this review is `release/win-unpacked-44.4.5-ready/Veyo.exe`. Other `release/win-unpacked*` folders are earlier or incomplete build attempts and should not be distributed.

## Before public distribution

- **Code sign the Windows executable and installer.** The verified executable is currently unsigned. ASAR integrity alone does not establish publisher trust when the executable itself can be replaced or modified.
- Close running development Electron sessions and run `npm ci` in the project root before the next package build. The existing root Electron distribution was locked by running processes and is incomplete; the clean build used an isolated install. The package command now rejects that incomplete installation.
- Re-run the dependency audit and package smoke test immediately before each release. New advisories and runtime patches can appear after this review.

## Plugins — 8 October 2026

Plugins (`electron/plugins/`, format in `docs/plugins.md`) add commands, agent presets, prompts, MCP server definitions and themes. A plugin can run programs as the user, so **installing one is a trust decision**, and the design keeps that decision explicit and visible.

**Trust model**

- Only the user adds marketplaces (typed or picked), except Veyo's own catalog (see *Plugin storefront* below), and only the user installs plugins. Every install and update first stages the plugin and shows a consent view: source address and full commit sha, author, license, every command line, every agent preset's arguments, every MCP server, prompts, skills and themes. Updates also show the version and command/agent/MCP changes. The files installed are exactly the staged files reviewed; nothing is fetched again after consent.
- Nothing from a plugin runs during preview or install: no install scripts, no hooks, no plugin JavaScript in the main process or renderer. Hooks are deliberately not supported.
- Plugin commands and agent presets start only on a user action, in a new visible terminal, spawned with an argument array (`electron/terminal-command.cjs`). PATH names are resolved from PATH only, never from the project; plugin files must still resolve inside the plugin. Arguments with control characters or `"` are refused; for `.cmd`/`.bat` programs `% ! ^ & | < >` are refused too, checked again after `${projectRoot}` substitution. The PowerShell path single-quotes every part, including typographic single quotes that PowerShell also treats as quotes.
- Agent presets cannot pass approval or sandbox flags (`--dangerously-skip-permissions`, `--permission-mode`, `--yolo`, `--full-auto`, `--sandbox`, `--ask-for-approval`, …).
- Manifests, README text and prompts are untrusted data. READMEs render through the chat Markdown renderer (no raw HTML, no remote images, links only through `link:open`). Prompt text is never submitted automatically; control characters are stripped before it is typed into a terminal, and it is only typed into agent terminals (which use bracketed paste) without pressing Enter.
- MCP servers are never started or written into another tool's configuration by Veyo. The user sees the exact `claude mcp add …` / `codex mcp add …` command and confirms; the CLI runs it in a visible terminal.
- Disabling or removing a plugin removes its contributions immediately; the main process re-resolves every command and preset at the moment it runs, so a stale renderer cannot run a disabled plugin's command.

**Files and Git**

- Plugins are copied (or cloned) into `userData/plugins/staging/<uuid>`, scanned, validated, then renamed into `userData/plugins/cache/<marketplace>/<name>/<version>`. Links of any kind are refused, manifest paths must be relative and resolve inside the plugin, and size and count limits apply (256 KB manifest, 1 MB per file, 2,000 files, 50 MB, depth 16). Previews expire after 30 minutes and staging is cleared at start-up.
- Installed plugins are re-validated on every start; an invalid one shows its error and contributes nothing. The registry (`userData/plugins/installed.json`) is written atomically through the existing helper, and a failed write leaves the previous registry in memory and on disk.
- Git uses the system `git` with an argument array and a 60-second timeout, shallow single-branch clones without submodules, `core.fsmonitor`, hooks or symbolic links, `protocol.file`/`protocol.ext` disabled, and no credential or SSH prompts. Only `https://` and ssh remotes without embedded credentials are accepted; `ext::`, `file:` and option-like values are refused. A pinned sha must match the checked-out commit. `.git` is not copied into installed plugins.

**IPC surface added** (all through the existing sender check, every argument type- and length-checked in the main process): `plugins:state`, `plugins:contributions`, `plugins:details`, `plugins:pick-folder`, `plugins:preview`, `plugins:cancel-preview`, `plugins:install`, `plugins:set-enabled`, `plugins:uninstall`, `plugins:run-command`, `plugins:mcp-plan`, `plugins:mcp-add`, `plugins:catalog`, `plugins:add-marketplace`, `plugins:refresh-marketplace`, `plugins:remove-marketplace`, and the `plugins:changed` event. The renderer names plugins by registry key and contributions by namespaced key; it never supplies a program, argument list or install path.

**Residual risks**

- A plugin the user installs can run anything the user can, once the user chooses one of its commands. Review is the control; there is no sandbox.
- A plugin command may start a long-running or interactive program; it runs in a normal terminal the user can stop.
- Git operations run the user's configured credential helpers and global Git configuration (system configuration is kept so HTTPS works on Windows).
- `plugins:preview` accepts a local folder path from the renderer. It copies the folder only if it contains a plugin manifest, within the size limits, and returns only what the consent view shows.

## Plugin storefront — 8 October 2026

**Built-in catalog.** `electron/plugins/public.cjs` names one catalog, `https://github.com/Aamirazmy92/veyo-plugins.git`. It is cloned (shallow, through the hardened Git path above) the first time Plugins is opened, never at start-up, refreshed in the background when a day old, and cannot be removed. Refreshing changes only the listing; nothing is installed or updated without the person's action. Whoever controls that repository controls what the storefront offers, so its listings are reviewed like code. `VEYO_PUBLIC_CATALOG` can point development builds at a local folder for tests; packaged builds ignore it, as they ignore `VEYO_DEV_URL`.

**One-click installs.** The main process classifies each staged plugin. Only plugins whose contributions are prompts, skills or themes install on "+"; they cannot run anything, and the notification offers Undo. Anything with commands, agent presets or MCP servers opens a sheet that lists every command line and the exact MCP commands, with the full review one click away. Updates that are runnable always show the sheet.

**Icons.** Listing icons are read by the main process only from inside the marketplace (no links, `.svg`/`.png`/`.webp`, at most 256 KB) and passed as `data:` URLs, which the renderer's CSP already allows. SVGs render through `<img>`, which runs no script and loads nothing external.

**MCP integrations (GitHub, Supabase, Gmail, Google Drive).** Veyo never receives a token or client secret:
- token servers reference an environment variable (`${GITHUB_PERSONAL_ACCESS_TOKEN}`); verified with a throwaway Claude configuration that Claude Code stores the reference and expands it only when it connects. Veyo reports only whether the variable is set (its own environment, and `reg query HKCU\Environment` existence on Windows), never the value;
- own-OAuth-client servers take the client ID in Veyo (validated to `[A-Za-z0-9._-]`), and Claude Code prompts for the secret with masked input in the visible terminal; it stores it in its own credential store, not in its config file (verified);
- sign-in servers authenticate in the browser through the CLI. `codex mcp add` signs in to OAuth servers by itself as part of adding them (observed while testing Supabase); the sheet says so.
- Plugin-supplied text is never evaluated as a pattern (no plugin regexes run in the main process).
- Connections are recorded only when the CLI's add command exits with 0, and uninstalling offers to run the CLI's own `mcp remove` in a terminal.

**IPC added:** `plugins:refresh-public`, `plugins:mcp-login`, `plugins:mcp-remove`; `plugins:mcp-plan` also accepts `preview:<id>` to show commands before installing (display only — `plugins:mcp-add` refuses preview keys).

**Brand marks.** The catalog shows GitHub, Supabase, Gmail, Google Drive and Claude marks from their owners' official sources, only to identify each service, with the real provider named on each listing and a trademark notice in the catalog README.

The app intentionally grants the selected coding agents and terminal the current user's operating-system privileges. Opening or running code in an untrusted project therefore requires the same care as running it in a normal terminal.

Reference guidance: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), and [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).

## Untrusted content reaching commands — 18 October 2026

A full review of the app after the browser history, terminal drop and plugin work. Fixed:

- **Element picker → agent terminal.** A page controls the picked element's text, HTML, selector and styles. These are now stripped of control characters (`buildPickPrompt`), and the prompt is pasted through `terminalPaste()`, so a page cannot end the bracketed paste early and type its own keystrokes (for example `!command` in Claude Code).
- **Repository Git filters.** `git status` re-reads files through `filter.<driver>.clean`, so a project unpacked with its `.git/config` could run a program as soon as it was opened. Every Git call now switches off filter drivers that the repository config defines or changes, while drivers in the person's global or system config (Git LFS) keep working. Tests prove that Git would run the planted filter and that status, diff and stage do not.
- **Dropped file paths.** Paths are quoted for the terminal they are pasted into: single quotes for PowerShell (typographic quotes doubled) and POSIX shells, which expand nothing; Command Prompt refuses `%` and `!`, which it expands even inside quotes; agent prompts keep Windows Terminal's double quotes. Names with control characters are refused everywhere.
- **Project Claude settings in chat.** The Agent SDK loads every settings source when `settingSources` is omitted and skips Claude Code's folder trust prompt, so a project's `.claude/settings.json` could run hooks or pre-approve tools. Project chats now load only the person's user settings until they trust the project. The first Claude chat in a project that has `.claude`, `CLAUDE.md`, `CLAUDE.local.md` or `.mcp.json` asks once; the main process reads the decision from the saved project and ignores the renderer's say (`project:claude-settings`, `project:set-claude-settings`).

Open, lower risk:

- `terminal:drop-image-download` fetches any http(s) address, including localhost and the local network, with the built-in browser's cookies. Only real image bytes are saved and the person must drag the image.
- Programmatic `webview.loadURL` does not emit `will-navigate`, so only the renderer checks addresses typed or picked from history.
- Codex chat without a project runs read-only with approval `never` in the home folder, so it can read any file there.
- `git:commit` runs the repository's commit hooks and `gpg.program`, as Git does in a terminal. Submodules are not covered by the filter override.
- A trust decision cannot yet be changed from the UI (edit `claudeSettings` in `workspaces.json`).
- `npm audit` reports 14 advisories (4 high). The only one in shipped runtime code is `@modelcontextprotocol/sdk` (through the Claude Agent SDK); the rest are build tooling.
