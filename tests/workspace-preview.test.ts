import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createWorkspacePreviewNode, readPreview, validPath, validPort } from '../apps/agent-node/src/workspace-preview.ts';

test('a port and a path are checked before anything is asked of the computer', () => {
  for (const port of [1, 80, 3000, 65535]) assert.equal(validPort(port), true);
  for (const port of [0, -1, 65536, 1.5, '3000', null, undefined, NaN]) assert.equal(validPort(port), false);
  for (const path of ['/', '/about', '/a?b=c#d', '']) assert.equal(validPath(path), true);
  // A path that could reach another host, or break the request line, is refused.
  for (const path of ['//elsewhere/', 'http://elsewhere/', 'https://x', '/a\r\nb', '/a\0b', 'x'.repeat(2049)]) assert.equal(validPath(path), false);
});

test('a page from a server on this computer is read with its status and type, and cut at the limit', async t => {
  const asked: string[] = [];
  const service = createServer((req, res) => {
    asked.push(req.url ?? '');
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(600 * 1024)); return; }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end('{"ok":true}'); return; }
    if (req.url === '/image') { res.writeHead(200, { 'content-type': 'image/png' }).end(); return; }
    if (req.url === '/gone') { res.writeHead(302, { location: '/somewhere-else' }).end(); return; }
    if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'text/html' }).end('not here'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>Hello</h1>');
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => { service.closeAllConnections(); service.close(() => resolve()); }));
  const port = (service.address() as { port: number }).port;
  const page = await readPreview(port, '/');
  assert.equal(page.ok, true);
  assert.equal(page.status, 200);
  assert.equal(page.type, 'text/html');
  assert.equal(page.text, '<h1>Hello</h1>');
  assert.equal(page.port, port);
  assert.equal(page.path, '/');
  assert.equal(typeof page.ms, 'number');
  // The type is given without its parameters; a 404 is read as what it says; JSON is read as text.
  const json = await readPreview(port, '/json');
  assert.equal(json.type, 'application/json');
  assert.equal(json.text, '{"ok":true}');
  const missing = await readPreview(port, '/missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.text, 'not here');
  // A page over the limit is cut, and says so. An image is not shown as text.
  const big = await readPreview(port, '/big');
  assert.equal(big.text?.length, 512 * 1024);
  assert.match(big.error!, /512 KiB/);
  assert.match((await readPreview(port, '/image')).error!, /image\/png/);
  // A redirect is reported and not followed.
  const gone = await readPreview(port, '/gone');
  assert.equal(gone.status, 302);
  assert.match(gone.error!, /跳转到 \/somewhere-else/);
  // Every read went to this computer's loopback, with the path as given.
  assert.deepEqual(asked, ['/', '/json', '/missing', '/big', '/image', '/gone']);
});

test('a port with nothing on it, or one that does not answer in time, says so', async () => {
  const nothing = await readPreview(1, '/');
  assert.equal(nothing.ok, false);
  assert.equal(nothing.status, 0);
  assert.match(nothing.error!, /没有在运行的服务/);
  // A server that never answers is given up on.
  const { createServer: make } = await import('node:http');
  const slow = make(() => {});
  await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', () => resolve()));
  const timedOut = await readPreview((slow.address() as { port: number }).port, '/', { timeoutMs: 200 });
  assert.match(timedOut.error!, /5 秒内没有回应|没有在运行/);
  slow.closeAllConnections();
  await new Promise<void>(resolve => slow.close(() => resolve()));
});

test('the handler checks its parameters and reads through', async t => {
  const service = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => { service.closeAllConnections(); service.close(() => resolve()); }));
  const port = (service.address() as { port: number }).port;
  const node = createWorkspacePreviewNode();
  const handler = node.handlers['workspace.preview.read']!;
  await assert.rejects(handler({ port: 0 }, () => {}), /端口无效/);
  await assert.rejects(handler({ port, path: '//elsewhere/' }, () => {}), /路径无效/);
  await assert.rejects(handler({ port, host: 'elsewhere' }, () => {}), /只接受 port 和 path/);
  const page = await handler({ port }, () => {}) as { text: string; status: number };
  assert.deepEqual({ status: page.status, text: page.text }, { status: 200, text: 'ok' });
});
