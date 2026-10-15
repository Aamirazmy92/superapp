const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
/*
 * `commands` are tried in order. `notBeside` skips a candidate that sits in the
 * same directory as another tool's executable: Grok's installer also ships an
 * `agent.exe`, which must not be mistaken for Cursor Agent.
 */
const catalog = [
  { id: 'claude', label: 'Claude Code', commands: ['claude'], mark: '✳' },
  { id: 'codex', label: 'Codex', commands: ['codex'], mark: '◎' },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    commands: ['cursor-agent', 'agent'],
    notBeside: 'grok',
    mark: '◇',
  },
  { id: 'gemini', label: 'Gemini CLI', commands: ['gemini'], mark: '✦' },
  { id: 'antigravity', label: 'Antigravity CLI', commands: ['agy'], mark: 'A' },
  { id: 'grok', label: 'Grok Build', commands: ['grok'], mark: 'X' },
  { id: 'copilot', label: 'GitHub Copilot', commands: ['copilot'], mark: '⌘' },
  { id: 'opencode', label: 'OpenCode', commands: ['opencode'], mark: '▣' },
  { id: 'droid', label: 'Droid', commands: ['droid'], mark: '⬡' },
  { id: 'amp', label: 'Amp', commands: ['amp'], mark: 'A' },
  { id: 'kimi', label: 'Kimi Code', commands: ['kimi'], mark: 'K' },
  { id: 'qwen', label: 'Qwen Code', commands: ['qwen'], mark: 'Q' },
  { id: 'aider', label: 'Aider', commands: ['aider'], mark: 'A' },
  { id: 'goose', label: 'Goose', commands: ['goose'], mark: 'G' },
  { id: 'crush', label: 'Crush', commands: ['crush'], mark: 'C' },
  { id: 'cline', label: 'Cline', commands: ['cline'], mark: 'C' },
  { id: 'kilo', label: 'Kilo Code', commands: ['kilo'], mark: 'K' },
  { id: 'auggie', label: 'Auggie', commands: ['auggie'], mark: 'A' },
  { id: 'kiro', label: 'Kiro CLI', commands: ['kiro-cli'], mark: 'K' },
  { id: 'junie', label: 'Junie', commands: ['junie'], mark: 'J' },
  { id: 'qoder', label: 'Qoder CLI', commands: ['qodercli'], mark: 'Q' },
  { id: 'vibe', label: 'Mistral Vibe', commands: ['vibe'], mark: 'M' },
  { id: 'hermes', label: 'Hermes Agent', commands: ['hermes'], mark: 'H' },
  { id: 'pi', label: 'Pi', commands: ['pi'], mark: 'π' },
  { id: 'openhands', label: 'OpenHands', commands: ['openhands'], mark: 'O' },
  { id: 'terminal', label: 'Terminal', commands: [], mark: '>_' },
];

function readRegistryPath(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true }, (error, stdout) => {
      const match = !error && /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout);
      resolve(
        match
          ? match[1].trim().replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
          : '',
      );
    });
  });
}

/*
 * The inherited PATH plus, on Windows, the current user and machine PATH from the
 * registry, so CLIs installed while the app is running are found without a restart.
 */
async function searchPath() {
  const entries = (process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'win32') {
    const stored = await Promise.all([
      readRegistryPath('HKCU\\Environment'),
      readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    ]);
    entries.push(...stored.flatMap((value) => value.split(path.delimiter)));
  }
  const seen = new Set();
  return entries
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => {
      if (!entry || !path.isAbsolute(entry)) return false;
      const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function executable(command, directories) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
  // Search PATH directories only, never a project's potentially untrusted executable.
  for (const directory of directories) {
    for (const ext of extensions) {
      const candidate = path.join(directory, command + ext);
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(
          candidate,
          process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
        );
        return candidate;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  }
  return null;
}

async function resolveAgent(agent, directories) {
  const blocked = agent.notBeside && (await executable(agent.notBeside, directories));
  const allowed = blocked
    ? directories.filter((directory) => directory !== path.dirname(blocked))
    : directories;
  for (const command of agent.commands) {
    const found = await executable(command, allowed);
    if (found) return found;
  }
  return null;
}

async function listAgents(directories) {
  directories ||= await searchPath();
  return Promise.all(
    catalog.map(async ({ commands, notBeside, ...agent }) => {
      const resolved = await resolveAgent({ commands, notBeside }, directories);
      return {
        ...agent,
        command: commands[0] || '',
        executable: resolved,
        installed: agent.id === 'terminal' || !!resolved,
      };
    }),
  );
}
module.exports = { listAgents, catalog, searchPath, executable };
