# Prompt: rebuild the chat Files pane to match Claude Code's

Copy everything below the line into a new session in this repo.

---

Rework the chat section's project file pane in Veyo (`D:\superapp`, Electron + React + Monaco) so that it looks and behaves like the Files pane in the Claude Code desktop app. A first version already exists. Replace its presentation and keep its editing core.

## What exists now (build on it, don't start over)

- `src/ChatFiles.tsx` is the current pane. It has a tree (`FileTree`), a "Search files" box, and one file at a time in Monaco via `FileEditor` with `modelScheme="veyo-chat"`, so its models stay apart from the Code view's. It also has save (Ctrl+S, handled inside the pane), revision-checked writes with the disk-conflict flow, a Save / Discard / Cancel prompt when leaving unsaved edits, and per-project state that survives closing the pane.
- `src/ChatWorkspace.tsx` adds a "Project files" button in the chat header and renders `<ChatFiles>`. Only one of Files and "Session details" (`ChatRail`) is open at a time.
- `src/chat.css` holds the `.chat-files*` rules. `--side-w` sizes the conversation and composer beside whichever side panel is open.
- `src/FileTree.tsx` is the tree. Its `FileIcon` maps file types to icons.
- These backend calls exist through `window.workspace`:
  - `listFiles(id, dir, includeIgnored)`
  - `searchFiles(id, query)` matches path names, up to 150 results.
  - `searchContent(id, query, caseSensitive)` returns `{ matches: ContentMatch[], truncated }`.
  - `readFile` and `saveFile(id, path, content, revision)`
  - `createEntry(id, path, directory)`, `renameEntry(id, path, next)` and `trashEntry(id, path)`
- Test: `tests/chat-files.electron.cjs` (run with `node tests/chat-files.electron.cjs` after `npm run build`, with `VEYO_DEV_URL` unset). Keep it passing and extend it.

Keep all of the existing behavior (saving, conflicts, unsaved-edit prompt, model isolation, Ctrl+S scoping, per-project state) unless this spec replaces it.

## Reference: Claude Code's Files pane (from a screenshot of the app)

Match these exactly:

1. **Opening it.** The window's top-right has a row of icon toggles for its side panes: terminal (`>_`), a second pane icon, a globe (browser) and a folder (Files). The active one is tinted blue. Files is opened from that row, not from a text button. In Veyo, put a folder-icon toggle in the same top-right position for chat mode. It replaces the current header button. Use the blue-tinted active state.
2. **The pane is a floating card.** It is inset from the window edges, with rounded corners, a 1px border and its own background, not a flush full-height strip. It is about 290px wide and runs nearly the full height.
3. **Header row.** The title "Files" sits on the left in semibold. On the right are five icon buttons, in this order:
   1. Search (magnifier): focuses the filter.
   2. View toggle (list icon): switches between the tree and a flat list. It's tinted blue while active.
   3. More (vertical dots): opens a menu.
   4. Expand (diagonal arrows): widens the pane.
   5. Close (X).
4. **Filter box.** It spans the full width, with a magnifier icon and a rounded field with a blue focus ring. The placeholder is exactly `Filter, or ? to search in files`. Plain text filters file names (`searchFiles`). Text starting with `?` searches file contents (`searchContent`). It is focused when the pane opens.
5. **Tree.**
   - Folders come first, then files, each sorted case-insensitively. Dotfiles and folders are listed (`.claude`, `.gitignore`).
   - Build output and dependency folders are shown too (`node_modules`, `dist`, `build`, `output`), so list with `includeIgnored: true`.
   - Folders have only a chevron (`>`), with no folder icon. Files have no chevron and get a small coloured type icon instead.
   - Type icons: `.gitignore` gets an orange-red git diamond, `.json` gets orange `{}`, `.md` gets a green markdown mark, `.html` gets an orange `#`/tag mark, `vite.config.ts` gets a purple lightning mark, and `.prettierrc.json` gets its own mark. Extend `FileIcon` (or add a chat-pane variant) with a small extension-to-colour map. Don't add an icon font dependency.
   - Rows are compact (about 24px), with plain text in the normal text colour and no row borders.

## Behavior I couldn't see. Confirm with the user before building these

Ask for screenshots of these states, or ask the user to describe them. Don't guess silently:

- What clicking a file does: opens an editor inside the pane, opens a wider editor next to it, or previews it read-only first.
- What the More (⋮) menu contains, for example new file, new folder, show hidden files, refresh, collapse all, reveal in Explorer.
- What Expand does: widens the pane, or replaces the chat view with the files.
- What the flat list view shows: every file with its path, or recently changed files.
- What `?` content-search results look like: grouped by file with the matching lines, and whether clicking one opens the file at that line.
- Whether files that agents changed in this chat get a marker, and whether ignored folders are dimmed.
- Whether right-clicking a row opens a context menu (rename, delete, copy path).

Until they answer, keep the current behavior for opening and editing a file (the editor inside the pane, with back to tree), and leave unconfirmed controls hidden rather than half-working.

## Constraints

- Reuse the existing `--menu-*`, `--hairline*`, `--raised` and `--text` tokens and the blue accent already used for active controls. Check both dark and light themes (`document.documentElement.dataset.theme = 'light'`).
- Keep the composer and conversation sized beside the pane through `--side-w`. Below 860px the pane overlays the chat.
- Accessibility:
  - Every icon button has an `aria-label` and a tooltip.
  - The tree keeps `role="tree"` with arrow-key navigation.
  - The filter box is labelled.
  - Escape clears the filter first, then closes the pane.
- Writes go through `saveFile` with the revision, and create, rename and delete use the existing calls. Deleting moves the file to the trash (`trashEntry`) and asks first.
- Don't touch the Code view's file explorer.

## Done when

- Screenshots of the pane, with the tree open, the filter in use, a `?` content search and a file open, side by side with the reference in both themes, show matching layout, header icons, placeholder, row density and icons.
- `tests/chat-files.electron.cjs` covers:
  - the toggle in the top-right row
  - focus moving to the filter when the pane opens
  - name filtering
  - `?` content search
  - the view toggle
  - Escape behavior
  - everything it already covers
- `npx tsc --noEmit`, `npm test` and the chat, editor and settings Electron tests pass. If some other in-progress change already breaks a test, report it rather than "fixing" that change.
