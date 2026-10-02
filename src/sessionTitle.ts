const CONTROL_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|.)/g;

const quietCommands = new Set([
  'cd',
  'cd..',
  'pwd',
  'clear',
  'cls',
  'dir',
  'echo',
  'exit',
  'history',
  'hostname',
  'logout',
  'ver',
  'whoami',
  'ls',
  'll',
  'la',
  'tree',
  'code',
  'explorer',
  'vim',
  'nvim',
  'nano',
]);

const packageManagers = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const testRunners = new Set([
  'jest',
  'mocha',
  'pytest',
  'vitest',
  'cypress',
  'playwright',
  'rspec',
]);

export function stripTerminalControls(value: string) {
  return value.replace(CONTROL_SEQUENCE, '');
}

function commandParts(command: string) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

function commandName(value: string) {
  return value
    .replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(cmd|exe|ps1)$/i, '');
}

function humanize(value: string) {
  return value
    .replace(/^['"]|['"]$/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, limit = 48) {
  if (value.length <= limit) return value;
  const shortened = value
    .slice(0, limit - 1)
    .replace(/\s+\S*$/, '')
    .trim();
  return `${shortened || value.slice(0, limit - 1).trim()}…`;
}

function sentence(value: string) {
  const cleaned = value.replace(/[.!?]+$/, '').trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
}

// Openers that carry no meaning in a title: greetings, then requests.
const PROMPT_OPENER =
  /^(?:(?:hey|hi|hello|ok|okay|so|alright|um|now)\b[,.!\s-]*|(?:please|pls|can you|can u|could you|would you|will you|help me|i need you to|i want you to|i'd like you to|i would like you to|i want to|i need to|we need to|let's|lets|go ahead and|try to|also)\b[,:\s-]*)/i;
// Replies to the agent rather than a task: confirmations, menu picks, nudges.
const PROMPT_REPLY =
  /^(?:y|n|yes|no|yep|nope|sure|ok|okay|thanks|thank you|ty|continue|go on|go ahead|proceed|do it|yes please|try again|retry|keep going|looks good|lgtm|done|next|\d+)[\s.!]*$/i;
// Commands that start a fresh conversation in the agent CLIs.
const AGENT_RESET = /^\/(?:clear|new|reset)\b/i;
// Where a long title can end without losing its meaning.
const CLAUSE_BREAK = /,\s|\s[-–—]\s|\s(?:and|so|because|but|then|which|where)\s/gi;

function clauseTitle(value: string, limit = 48) {
  if (value.length <= limit) return value;
  let cut = 0;
  for (const match of value.matchAll(CLAUSE_BREAK)) {
    if (match.index! > limit) break;
    cut = match.index!;
  }
  return cut >= 16 ? value.slice(0, cut) : truncate(value, limit);
}

export function isAgentContextReset(prompt: string) {
  return AGENT_RESET.test(prompt.trim());
}

// A short title for a prompt sent to an agent, or undefined when the prompt is
// a reply or CLI command rather than a task.
// Pasted prompts open with rules, quotes, bullets and headings; a title is the
// first line that still has words once that decoration is gone.
const HAS_WORDS = /[\p{L}\p{N}]/u;
function firstMeaningfulLine(prompt: string) {
  for (const line of prompt.split('\n')) {
    const text = line
      .replace(/^[\s>#*\-–—_=~`+•·|]+(?:\d+[.)]\s+)?/u, '')
      .replace(/[\s*_=~`|]+$/u, '')
      .trim();
    if (HAS_WORDS.test(text)) return text;
  }
  return '';
}

export function summarizeAgentPrompt(prompt: string) {
  const trimmed = firstMeaningfulLine(stripTerminalControls(prompt));
  if (trimmed.startsWith('/') || PROMPT_REPLY.test(trimmed)) return undefined;
  let cleaned = trimmed
    // File mentions (@src/App.tsx) read better as the file name alone.
    .replace(/(^|\s)@(?:[\w.-]+[\\/])*([\w.-]+)/g, '$1$2')
    .replace(/\s+/g, ' ');
  for (let previous = ''; previous !== cleaned; ) {
    previous = cleaned;
    cleaned = cleaned.replace(PROMPT_OPENER, '');
  }
  const [first = ''] = cleaned.split(/(?<=[.!?])\s+/);
  const title = first
    .replace(/[\s,]+(?:please|for me|thanks|thank you)[\s.!?]*$/i, '')
    .replace(/\bi\b/g, 'I')
    .trim();
  if (title.length < 4 || PROMPT_REPLY.test(title)) return undefined;
  return clauseTitle(sentence(title));
}

function summarizeSegment(segment: string) {
  const trimmed = segment.trim();
  if (!trimmed) return undefined;

  const parts = commandParts(trimmed);
  if (!parts.length) return undefined;
  const firstPart = parts[0];
  if (!firstPart) return undefined;
  const executable = commandName(firstPart);
  const args = parts.slice(1).map((part) => part.replace(/^['"]|['"]$/g, ''));
  const firstArgument = args.find((part) => !part.startsWith('-'))?.toLowerCase() || '';

  if (quietCommands.has(executable)) return undefined;

  if (packageManagers.has(executable)) {
    const verbIndex = args.findIndex((part) => !part.startsWith('-'));
    const verb = verbIndex === -1 ? '' : args[verbIndex].toLowerCase();
    const subject = verbIndex === -1 ? '' : args[verbIndex + 1] || '';
    if (['install', 'i', 'add', 'ci'].includes(verb)) return 'Install project dependencies';
    if (['test', 'check'].includes(verb)) return 'Run project tests';
    if (['build', 'compile'].includes(verb)) return 'Build the project';
    if (['start', 'dev', 'serve'].includes(verb)) return 'Run the development server';
    if (verb === 'run' && ['test', 'check'].includes(subject.toLowerCase()))
      return 'Run project tests';
    if (verb === 'run' && ['build', 'compile'].includes(subject.toLowerCase()))
      return 'Build the project';
    if (verb === 'run' && ['start', 'dev', 'serve'].includes(subject.toLowerCase()))
      return 'Run the development server';
    if (verb === 'run' && subject) return `Run ${humanize(subject)} script`;
    if (verb) return `Run ${humanize(verb)} task`;
    return 'Work on the JavaScript project';
  }

  if (executable === 'npx' || executable === 'pnpx') {
    const tool = args.find((part) => !part.startsWith('-')) || '';
    const toolName = commandName(tool);
    if (testRunners.has(toolName)) return 'Run project tests';
    if (['vite', 'next', 'serve', 'webpack-dev-server'].includes(toolName))
      return 'Run the development server';
    if (toolName === 'prettier' || toolName === 'eslint') return 'Check project quality';
    if (tool) return `Run ${humanize(tool)} tool`;
  }

  if (executable === 'git') {
    if (firstArgument === 'status' || firstArgument === 'diff' || firstArgument === 'show')
      return 'Review Git changes';
    if (firstArgument === 'log') return 'Review Git history';
    if (firstArgument === 'add') return 'Stage project changes';
    if (firstArgument === 'commit') return 'Commit project changes';
    if (['branch', 'checkout', 'switch', 'merge', 'rebase'].includes(firstArgument))
      return 'Manage Git branches';
    if (['pull', 'push', 'fetch', 'clone'].includes(firstArgument)) return 'Sync Git changes';
    if (firstArgument) return `Use Git: ${humanize(firstArgument)}`;
    return 'Work with Git';
  }

  if (testRunners.has(executable) || firstArgument === 'test') return 'Run project tests';
  if (
    [
      'tsc',
      'tsup',
      'rollup',
      'webpack',
      'esbuild',
      'cargo',
      'go',
      'dotnet',
      'mvn',
      'gradle',
    ].includes(executable) &&
    ['build', 'compile', 'test'].includes(firstArgument)
  ) {
    return firstArgument === 'test' ? 'Run project tests' : 'Build the project';
  }
  if (
    ['vite', 'next', 'serve', 'flask', 'uvicorn', 'http-server', 'webpack-dev-server'].includes(
      executable,
    )
  )
    return 'Run the development server';

  if (['rg', 'grep', 'find', 'select-string'].includes(executable)) return 'Search project files';
  if (['cat', 'type', 'get-content', 'less', 'more'].includes(executable))
    return 'Inspect project files';
  if (
    [
      'mkdir',
      'new-item',
      'touch',
      'del',
      'rm',
      'remove-item',
      'mv',
      'move-item',
      'cp',
      'copy-item',
    ].includes(executable)
  )
    return 'Manage project files';

  if (['python', 'python3', 'node', 'deno'].includes(executable)) {
    const script = args.find((part) => !part.startsWith('-') && /[./\\]/.test(part));
    return script
      ? `Run ${humanize(script)}`
      : `Run ${executable === 'node' ? 'Node.js' : 'Python'} code`;
  }
  if (executable === 'docker' || executable === 'docker-compose') return 'Work with Docker';
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod'].includes(executable))
    return 'Inspect an HTTP endpoint';

  if (parts.length === 1 && /[\\/]/.test(firstPart)) return `Run ${humanize(commandName(firstPart))}`;

  return `Run ${trimmed.replace(/\s+/g, ' ')}`;
}

function summarizeCommand(command: string) {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map(summarizeSegment)
    .find(Boolean);
}

// A shell is titled by the latest command that says what it is doing, since
// later commands (a dev server after an install) replace the earlier work.
export function summarizeShellCommands(commands: string[]) {
  for (const command of [...commands].reverse()) {
    const title = summarizeCommand(command);
    if (title) return truncate(title);
  }
  return undefined;
}

export function displayTerminalLabel(label: string, agentId?: string) {
  return agentId ? label.replace(/\s+\d+$/, '') : label;
}

export function displayTerminalTitle(
  sessionTitle: string | undefined,
  label: string,
  agentId?: string,
) {
  const displayLabel = displayTerminalLabel(label, agentId);
  const title = sessionTitle?.trim();
  if (!title || !HAS_WORDS.test(title) || /^new terminal session$/i.test(title)) return displayLabel;
  const numberedAgentTitle =
    !!agentId &&
    title.startsWith(`${displayLabel} `) &&
    /^\d+$/.test(title.slice(displayLabel.length + 1));
  if (agentId && (title === label || title === displayLabel || numberedAgentTitle)) {
    return displayLabel;
  }
  return title;
}
