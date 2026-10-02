import type { AgentSelection, GitStatus, SavedSession, TerminalInfo, WorkspaceMeta } from './types';

export type Work = SavedSession & { terminals: TerminalInfo[] };

export function agentSelectionsFor(items: readonly { agentId?: string }[]): AgentSelection[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const agentId = item.agentId || 'terminal';
    counts.set(agentId, (counts.get(agentId) || 0) + 1);
  }
  return [...counts].map(([agentId, count]) => ({ agentId, count }));
}
export const newWork = (): Work => ({
  files: [],
  layout: 'terminal',
  terminalHeight: 320,
  terminals: [],
});
export const baseName = (path: string) => path.split('/').pop() || path;
export const language = (path: string) => {
  const name = baseName(path).toLowerCase();
  if (/^(dockerfile|containerfile)(\.|$)/.test(name)) return 'dockerfile';
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mts: 'typescript',
        cts: 'typescript',
        mjs: 'javascript',
        cjs: 'javascript',
        json: 'json',
        jsonc: 'json',
        css: 'css',
        scss: 'scss',
        less: 'less',
        html: 'html',
        htm: 'html',
        md: 'markdown',
        mdx: 'markdown',
        py: 'python',
        rs: 'rust',
        yml: 'yaml',
        yaml: 'yaml',
        sh: 'shell',
        ps1: 'powershell',
        bash: 'shell',
        go: 'go',
        c: 'c',
        h: 'cpp',
        cpp: 'cpp',
        hpp: 'cpp',
        cs: 'csharp',
        java: 'java',
        sql: 'sql',
        xml: 'xml',
        svg: 'xml',
        toml: 'ini',
        ini: 'ini',
        rb: 'ruby',
        php: 'php',
        bat: 'bat',
        cmd: 'bat',
      } as Record<string, string>
    )[name.split('.').pop() || ''] || 'plaintext'
  );
};
export const emptyGit: GitStatus = { available: false, branch: '', files: [] };

export const withoutKey = <T>(record: Record<string, T> | undefined, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};
/** Every group name used in a project, in the order groups were first used. */
export function workspaceGroups(meta: Record<string, WorkspaceMeta> = {}) {
  return [...new Set(Object.values(meta).flatMap((entry) => (entry.group ? [entry.group] : [])))];
}
/** Toasts are plain strings; warnings and failures read as errors. */
export function toastIsError(message: string) {
  return /\b(cannot|could not|couldn't|required|failed|error|keep at least|already exists|must)\b/i.test(
    message,
  );
}

/**
 * Sidebar order for a project's workspaces: pinned first, then ungrouped, then
 * each group under its heading. Archived workspaces are listed separately.
 */
export function workspaceSections(names: string[], meta: Record<string, WorkspaceMeta> = {}) {
  const visible = names.filter((name) => !meta[name]?.archived);
  const rest = visible.filter((name) => !meta[name]?.pinned);
  const groups = [
    ...new Set(rest.flatMap((name) => (meta[name]?.group ? [meta[name].group!] : []))),
  ];
  return {
    sections: [
      { id: 'pinned', title: '', names: visible.filter((name) => meta[name]?.pinned) },
      { id: 'ungrouped', title: '', names: rest.filter((name) => !meta[name]?.group) },
      ...groups.map((group) => ({
        id: `group:${group}`,
        title: group,
        names: rest.filter((name) => meta[name]?.group === group),
      })),
    ].filter((section) => section.names.length),
    archived: names.filter((name) => meta[name]?.archived),
  };
}
/** The part of a workspace that is saved; live terminals become relaunch presets. */
export const sessionFor = (w: Work): SavedSession => ({
  workspaceNames: w.workspaceNames,
  workspaceMeta: w.workspaceMeta,
  activeWorkspace: w.activeWorkspace,
  files: w.files,
  activeFile: w.activeFile,
  layout: w.layout,
  terminalHeight: w.terminalHeight,
  terminalPresets: [
    ...(w.terminalPresets || []).filter(
      (preset) =>
        !w.terminals.some(
          (terminal) => (terminal.workspaceName || 'Main') === (preset.workspaceName || 'Main'),
        ),
    ),
    ...w.terminals
      .filter((terminal) => !terminal.exited)
      .map(({ id, label, shell, agentId, workspaceName, sessionTitle }) => ({
        terminalId: id,
        label,
        shell,
        agentId,
        workspaceName,
        sessionTitle,
      })),
  ],
});
