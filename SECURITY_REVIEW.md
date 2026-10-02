# Security review — 26 September 2026

This review covered the Electron main process and preload bridge, renderer content, project file and Git operations, local chat/preview endpoints, dependency advisories, and the Windows package. It is a review of this codebase and build, not a guarantee against every future vulnerability.

## Fixed

- Packaged builds ignore `SUPERAPP_DEV_URL`. Development builds accept only a root URL on `127.0.0.1` with an explicit port. The package smoke test supplies a hostile URL and verifies that the local `file://` UI still loads.
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

The verified executable from this review is `release/win-unpacked-44.4.5-ready/Superapp.exe`. Other `release/win-unpacked*` folders are earlier or incomplete build attempts and should not be distributed.

## Before public distribution

- **Code sign the Windows executable and installer.** The verified executable is currently unsigned. ASAR integrity alone does not establish publisher trust when the executable itself can be replaced or modified.
- Close running development Electron sessions and run `npm ci` in the project root before the next package build. The existing root Electron distribution was locked by running processes and is incomplete; the clean build used an isolated install. The package command now rejects that incomplete installation.
- Re-run the dependency audit and package smoke test immediately before each release. New advisories and runtime patches can appear after this review.

The app intentionally grants the selected coding agents and terminal the current user's operating-system privileges. Opening or running code in an untrusted project therefore requires the same care as running it in a normal terminal.

Reference guidance: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), and [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).
