// Builds the installer and publishes it as a GitHub release that installed copies of
// the app pick up. Usage: npm run release   (bump "version" in package.json first)
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const repo = 'Aamirazmy92/veyo-releases';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const tag = `v${version}`;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
const exists = () => {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore', shell: process.platform === 'win32' });
    return true;
  } catch {
    return false;
  }
};

if (exists()) throw new Error(`${tag} is already released. Bump "version" in package.json.`);
run('npm', ['run', 'dist']);
run('gh', [
  'release', 'create', tag,
  `release/Veyo-Setup-${version}.exe`,
  `release/Veyo-Setup-${version}.exe.blockmap`,
  'release/latest.yml',
  '--repo', repo, '--title', `Veyo ${version}`, '--notes', `Veyo ${version}`,
]);
console.log(`Published ${tag}. Installed copies update on their next check.`);
