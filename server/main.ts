import { WorkspaceCatalogStore } from './catalog.js';
import { createWorkspaceHandler } from './workspace-http.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { parseOptions } from './options.js';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2), appRoot);
options.projects = options.projects.map(p => realpathSync(p));
const catalog = new WorkspaceCatalogStore(options);
void catalog.refresh();
const catalogTimer = setInterval(() => { void catalog.refresh(); }, 5000);
const handler = createWorkspaceHandler(catalog,options.port);
const dist = resolve(appRoot, 'dist');
if (!options.dev && !existsSync(resolve(dist, 'index.html'))) throw new Error('Run pnpm build before pnpm start, or use pnpm dev.');
const vite = options.dev ? await createViteServer({ root: appRoot, server: { middlewareMode: true }, appType: 'spa' }) : null;
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res): Promise<void> => {
  if (handler.handle(req,res)) return;
  if (vite) { vite.middlewares(req, res); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  try {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const path = resolve(dist, `.${urlPath === '/' ? '/index.html' : urlPath}`);
    if (!path.startsWith(`${dist}${sep}`)) { res.writeHead(403).end(); return; }
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404).end('Not found'); }
});
server.on('error', (error): void => { console.error(error.message); process.exitCode = 1; void vite?.close(); });
server.listen(options.port, '127.0.0.1', (): void => {
  console.log(`Hooks workspace: http://127.0.0.1:${options.port}\nProjects: ${options.projects.length || 'automatic discovery'}\nManaged registry settings can be saved; hooks are not installed or executed by this server.`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (): void => { clearInterval(catalogTimer); handler.close(); server.close(); void vite?.close(); });
}
