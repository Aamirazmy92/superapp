const fs = require('node:fs/promises');
const path = require('node:path');

// Claude configuration a project can bring with it. Its settings can run
// hooks and pre-approve tools; the Agent SDK skips Claude Code's folder trust
// prompt, so chat loads them only after the person trusts the project.
const CLAUDE_CONFIG = ['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];

/** The Claude configuration files and folders present in a project. */
async function claudeConfigFiles(root) {
  const found = await Promise.all(
    CLAUDE_CONFIG.map((name) => fs.lstat(path.join(root, name)).then(() => name, () => null)),
  );
  return found.filter(Boolean);
}

/** 'trusted', 'ignored', or null while the person has not decided. */
function claudeSettingsDecision(project) {
  return ['trusted', 'ignored'].includes(project?.claudeSettings) ? project.claudeSettings : null;
}

module.exports = { claudeConfigFiles, claudeSettingsDecision };
