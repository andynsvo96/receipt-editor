const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const rendererUrl = 'http://localhost:5173';
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const electronPath = require('electron');

const renderer = spawn(process.execPath, [viteEntry, '--config', 'vite.desktop.config.ts', '--host', '127.0.0.1'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

function waitForRenderer(attempts = 80) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(rendererUrl, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else retry();
      });
      request.on('error', retry);
      request.setTimeout(500, () => request.destroy());
    };
    const retry = () => {
      if (attempts-- <= 0) reject(new Error('The desktop preview did not start.'));
      else setTimeout(check, 250);
    };
    check();
  });
}

waitForRenderer()
  .then(() => {
    const desktop = spawn(electronPath, ['.'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
    });
    desktop.on('exit', (code) => {
      renderer.kill();
      process.exit(code ?? 0);
    });
  })
  .catch((error) => {
    console.error(error.message);
    renderer.kill();
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => renderer.kill());
}
