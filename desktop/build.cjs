const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const requestedArgs = process.argv.slice(2);
const target = requestedArgs.find((argument) => ['--win', '--mac', '--linux'].includes(argument))
  ?? (process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux');

if (target === '--mac' && process.platform !== 'darwin') {
  console.error('Build the native Mac app on macOS or with the desktop GitHub Actions workflow. Use npm run desktop:standalone for the single-file offline browser edition, which also runs on Mac.');
  process.exit(1);
}

const args = [builderCli, target, ...requestedArgs.filter((argument) => argument !== target)];
if (target === '--win' && process.platform === 'win32') {
  args.push('--config.electronDist=node_modules/electron/dist');
}
if (!args.some((argument) => argument === '--publish' || argument.startsWith('--publish='))) {
  args.push('--publish', 'never');
}

const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? path.join(projectRoot, '.cache', 'electron-builder'),
    ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? path.join(projectRoot, '.cache', 'electron'),
  },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
