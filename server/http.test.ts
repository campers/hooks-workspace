import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { handleWorkspaceRequest } from './http.js';
import { parseOptions } from './options.js';

test('server serves the selected demo project, refuses writes and rejects foreign origins/hosts', async (t): Promise<void> => {
  let port = 0;
  const server = createServer((req, res): void => {
    if (!handleWorkspaceRequest(req, res, resolve('examples/demo'), port)) res.writeHead(404).end();
  });
  await new Promise<void>((done): void => { server.listen(0, '127.0.0.1', done); });
  t.after((): void => { server.close(); });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/api/workspace`;
  const response = await fetch(url);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /demo-review/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((done, reject): void => {
    const req = request(url, { headers: { Host: 'unrelated.example' } }, (res): void => { res.resume(); done(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHostStatus, 403);
});
test('project selection is resolved from caller cwd while demo resolves from app installation', (): void => {
  assert.deepEqual(parseOptions([], '/tools/hooks', '/projects/a').projects, []);
  assert.equal(parseOptions([], '/tools/hooks').discover, true);
  assert.deepEqual(parseOptions(['--demo'], '/tools/hooks').projects, ['/tools/hooks/examples/demo']);
  assert.deepEqual(parseOptions(['--project', '../b','--project','../c'], '/tools/hooks', '/projects/a').projects, ['/projects/b','/projects/c']);
  assert.throws(() => parseOptions(['--port', 'NaN'], '/tools/hooks'), /port/);
});
