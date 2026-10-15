<img src="src/assets/brand/veyo-wordmark.png" alt="Veyo" width="240" />

# Veyo

A Windows-first desktop coding workspace built with Electron, React, Monaco, and real PTY terminals.

## Run

Requires Node.js 22.12+ and npm. PowerShell and Command Prompt are supported on Windows; the default shell is used on other platforms (not yet verified).

```sh
npm install
npm run dev
```

On machines with a broken global npm shim, use the installed npm CLI directly:

```powershell
node 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' install
node scripts/dev.mjs
```

Open a folder with **Open project** or **Ctrl+O**. An optional launch argument opens a specific project:

```sh
npm run dev -- --project=D:/my-project
```

## Included in 0.1

- **Launch agents** opens a multi-select launcher: select installed coding CLIs, set a count for each, and open them together. A plain Terminal option is included. Each workspace supports up to 16 terminals; the launcher shows the total and remaining slots, marks CLIs missing from PATH, and reports partial launch failures. It does not install tools or change agent approval settings. On Windows, coding agents launch through PowerShell; the shell selector applies to plain terminals. Existing login/setup prompts appear in the terminal. Agent identity is saved in terminal presets for explicit relaunch after restarting.

- **Plan usage** for Claude Code and Codex: the dashboard reads Codex limits through the installed CLI app-server and Claude limits through its SDK structured usage method when supported. Claude's SDK method is experimental; supported older Windows/Linux CLIs can fall back to the OAuth endpoint with file credentials. CLI authentication handles OS credential storage and token renewal; compatibility readers never refresh or rewrite credentials. API-key and cloud-provider sessions show **Not applicable**. Standard 5-hour and weekly windows, provider-specific durations, and additional model buckets retain their own labels and reset times. Checks run every minute during terminal activity, every three minutes otherwise, after replies and usage notifications, and near resets. Hidden windows pause checks, and provider cooldowns are respected. Readings in `usage.json` and threshold notifications use opaque account identifiers that include the configuration directory and account/workspace. Identity is checked before showing a saved or cached reading; switching accounts or signing out clears the previous reading. If local identity cannot be verified, saved readings are withheld until a live account-bound response is available. Older unscoped caches are discarded. Codex session-log fallback only uses records that identify both the active user and workspace; legacy unscoped logs are ignored. An ended window shows awaiting update until a new reading confirms usage. Credentials and account email addresses never cross the usage IPC bridge or enter the usage cache.
- Real project folders, expandable file explorer, filename/path search.
- Monaco editing with tabs, Ctrl+S, syntax highlighting, word wrap, and font settings. Editor assets are bundled locally.
- Atomic file replacement with revision checks, external-change refresh, and conflict comparison. UTF-8 text files up to 4 MB; binary files are rejected.
- Multiple live terminals, automatic side-by-side panes, shell selection, renaming, process exit states, and adjustable terminal height.
- Terminal sessions receive short local titles from their first meaningful command or agent request; titles appear in the pane and sidebar and are kept with relaunch presets.
- Project switching preserves live terminal processes and open editor buffers.
- Saved project lists, layouts, tabs, and draft buffers. After restart, terminal presets can launch fresh shells; old processes are not resurrected and commands are not replayed.
- Build, Focus, and Terminal layouts; command palette with Ctrl+K; new terminal with Ctrl+backtick.
- Read-only Git status and tracked diffs. Use a terminal for Git staging and commits.
- Use the panel icon in the title bar to show project files or open the embedded browser beside the editor. Run a local server, enter its localhost address, and test with browser cookies and storage. The browser also accepts HTTPS sites; popups and permission requests are blocked.
- In the browser header, use the trash icon (**Clear browsing history**) to remove Back and Forward history. A confirmation appears when it finishes. The current page, cookies, and site storage stay intact, so you remain signed in. New navigation starts a fresh history.
- Installed coding CLIs can run in any terminal using their existing configuration. No hosted AI integration or API key is bundled.
- Local Ollama chat streams responses as they arrive, renders Markdown and code blocks, and opens web links in your browser. Stopping a response keeps the generated text and lets you retry.
- Coding chat uses the installed Codex or Claude Code CLI and its existing sign-in. Choose a project, provider, and model, then ask it to implement, fix, or test code. Tool activity shows commands and edits; expand an edit to read its details and use **Open file** to inspect the current code in the editor. Unsaved editor changes are preserved and surfaced as conflicts when the agent changes the same file.
- Attach images and UTF-8 text/code files with the paperclip, paste images into the composer, or drop files into chat. You can remove an attachment before sending. Up to 8 files and 20 MB per message are supported, with 5 MB per image and 1 MB per text file. Image inputs require a model that supports vision. Attachment bytes live in `chat-attachments` beside `chats.json`; history and unsent drafts store only references, and deleting saved conversations removes their unreferenced attachment files.
- Chat streams and tool updates are batched, and provider model catalogs are cached for five minutes. **Refresh chat models** forces discovery. Stop interrupts the active Codex turn and retains partial output, activity, and the provider session; retry and follow-up messages continue that session. Coding tasks time out after 15 minutes without activity instead of a fixed three-minute deadline. With Codex's **Ask for approval**, workspace edits are permitted and additional access prompts for approval; Claude delegates restricted actions to its approval policy.
- Ctrl+P opens a file finder with name and path search; Ctrl+K remains the command palette.
- Ask chat from an open editor file to start a project chat with the selected code, or attach the current file for review.
- **Plugins** (Ctrl+K → Plugins, or Settings → Plugins) add commands, agent presets, prompts and skills, MCP server definitions, and themes. **Public** shows Veyo's built-in catalog ([Aamirazmy92/veyo-plugins](https://github.com/Aamirazmy92/veyo-plugins)) with Popular and New & Noteworthy rows, including GitHub, Supabase, Gmail and Google Drive integrations; **Personal** shows what you installed and any marketplaces you added (`owner/repo`, an https or ssh Git address, or a folder). Plugins that only add prompts, skills or themes install with one click and can be undone; anything that can run commands, launch agents or add MCP servers opens a sheet listing every command line and the exact `claude mcp add` / `codex mcp add` command first, and the full review screen shows the source and commit, author, and everything the plugin contains. Tokens and OAuth client secrets never pass through Veyo: the coding CLI reads tokens from environment variables and asks for secrets in its own terminal. Plugins install for all projects or one project; enable, disable, update and uninstall take effect at once, and updates are only installed when you choose them. Plugin commands run in a new visible terminal; plugin contributions are labelled "from <plugin>" in the palette, Run command and agent pickers. MCP servers are added to Claude Code or Codex only through their own `mcp add` command, which you see and confirm. Claude Code plugins and marketplaces are read directly (prompts, skills, MCP servers). Plugins never run code inside Veyo and have no hooks. See [docs/plugins.md](docs/plugins.md) for the format and [`examples/marketplace`](examples/marketplace) for a sample.

## Build and verify

```sh
npm test
npm run build
npm start
npm run package
```

Chat integration checks use isolated profiles and local fixtures:

```sh
npm run build
node tests/chat-stream.electron.cjs
node tests/chat-coding.electron.cjs
```

The coding fixture runs on Windows using its installed .NET compiler. It exercises the actual Codex app-server adapter, attachments, approvals, source edits, editor navigation, cancellation, and restart persistence without model inference or changes to your projects.

Packaging produces an unpacked Windows app in `release/win-unpacked`. It is a development distribution, not a signed installer. The package command checks that the installed Electron version matches the pinned release, then uses its local distribution and node-pty's Windows prebuilt binary. Run `npm ci` after updating Electron, and verify terminal launch after changing either dependency.

For plugins, run `node tests/plugins.electron.cjs` after building, with `VEYO_DEV_URL` unset. It uses isolated app data and a copy of `examples/marketplace` as the built-in catalog (`VEYO_PUBLIC_CATALOG`, honoured only in development builds; no network), and covers the Public storefront, one-click install and Undo, the install sheet, a command in Ctrl+K running in a terminal, a theme, disable/enable, update with its change list, search, the built-in marketplace, a refused malicious folder, and uninstall. It unticks every MCP option, so it never changes your Claude Code or Codex configuration. The unit tests in `tests/plugins.test.cjs` (part of `npm test`) also clone local Git repositories, so they need `git` on PATH.

For the dashboard and plan-usage flows, run `node tests/usage.electron.cjs` and `node tests/dashboard.electron.cjs` after building. They use isolated app data and test credentials. The usage check uses a local HTTP server and covers live readings, offline restore, expired sign-ins, pending resets, refresh failure/recovery, and signed-out guidance. Screenshots are saved in `output/playwright/usage-*.png`.

The Windows terminal implementation calls `child_process.fork()` while closing a PTY, so Electron's `runAsNode` fuse must remain enabled until that dependency is replaced or changed. The package disables Node runtime options and the Node inspector, and enables ASAR integrity validation.

## Architecture

- `electron/main.cjs`: trusted desktop services, project grants, Git, process lifecycle, window controls.
- `electron/preload.cjs`: narrow IPC bridge, no general-purpose IPC or filesystem access exposed.
- `electron/core.cjs`: bounded file access, search, conflict-aware writes.
- `electron/usage-adapters.cjs`: CLI authentication, account validation, and compatibility readers.
- `electron/usage.cjs`: account-aware usage caching, limit parsing and provider cooldowns; `src/UsagePanel.tsx` renders it in the dashboard.
- `src/App.tsx`: workspace state, editor, navigation and preview UI.
- `src/workspaceModel.ts`: pure workspace helpers and the saved-session shape.
- `src/usePanelWidths.tsx`, `src/Notifications.tsx`, `src/CommandPalette.tsx`: resizable panels, task notifications and the Ctrl+K palette.
- `src/TerminalPane.tsx`: xterm rendering, buffered attachment, resize and input.

Workspace metadata and run-command presets are stored in Electron's local user-data directory as atomically replaced JSON (`workspaces.json`) for this first release; chat history and chat settings are kept beside it in `chats.json`. Older chats and presets saved in browser storage are imported the first time they are opened. SQLite can replace this layer when task history and richer querying are added. Source files remain in their existing project folders. Draft buffers contain source text, so the metadata directory should be treated as private project data. `VEYO_DATA_DIR` can select an isolated data directory for development and testing.

Filesystem operations reject paths and links leaving a selected project. A terminal deliberately has the privileges of your own shell; the selected folder is its starting directory, not an OS sandbox. Browser content does not receive the preload API. No arbitrary remote content is loaded in the privileged main frame.

## Next milestones

1. Run-command presets, richer file operations, content search, and integrated Git staging/commits.
2. Structured coding-agent adapter with reviewable edits and task states.
3. Per-task Git worktrees, language servers, debugging, and signed installers.

The first release does not provide cloud sync, collaboration, autonomous tasks, process recovery after a full app exit, or full VS Code extension support.
