import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
// Let Vite move to the next free port when 5173 is reserved by another
// process or by Windows' excluded port ranges. Electron receives the actual
// URL below, so the two processes always stay in sync.
const server = await createServer({
  server: {
    host: '127.0.0.1',
    // Port 0 asks the OS for a free localhost port. This also avoids Windows
    // excluded-port ranges that can report EACCES instead of EADDRINUSE.
    port: Number(process.env.SUPERAPP_DEV_PORT) || 0,
    strictPort: false,
  },
});
await server.listen();
const address = server.httpServer?.address();
const port = typeof address === 'object' && address ? address.port : 5173;
console.log(`[superapp] Vite running at http://127.0.0.1:${port}`);
const env = { ...process.env, SUPERAPP_DEV_URL: `http://127.0.0.1:${port}` };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill());
