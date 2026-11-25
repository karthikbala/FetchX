// A local copy of fixtures.fetchx.ai over plain HTTP, for tests and for runs
// against a browser on this machine:
//   node fixtures-worker/serve.mjs [port]
// The frame host is served on localhost and the site on 127.0.0.1, so the
// framed form stays cross-origin.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import worker from './worker.mjs';

export function serveFixtures({port = 0, host = '127.0.0.1', env = {}} = {}) {
  const local = {LOCAL_HTTP: true, ...env};
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (let at = 0; at < req.rawHeaders.length; at += 2) headers.append(req.rawHeaders[at], req.rawHeaders[at + 1]);
      const request = new Request(`http://${req.headers.host}${req.url}`, {method: req.method, headers, body});
      const answer = await worker.fetch(request, {...local, REMOTE_ADDRESS: req.socket.remoteAddress});
      const out = {};
      answer.headers.forEach((value, name) => { if (name !== 'set-cookie') out[name] = value; });
      const cookies = answer.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(answer.status, out);
      res.end(answer.body ? Buffer.from(await answer.arrayBuffer()) : undefined);
    } catch (error) {
      res.writeHead(500, {'content-type': 'text/plain'}).end(String(error?.message ?? error));
    }
  });
  return new Promise(resolve => server.listen(port, host, () => {
    const {port: bound} = server.address();
    local.FRAME_ORIGIN ??= `http://localhost:${bound}`;
    resolve({server, url: `http://${host}:${bound}`, frameOrigin: local.FRAME_ORIGIN,
      close: () => new Promise(done => server.close(done))});
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const {url, frameOrigin} = await serveFixtures({port: Number(process.argv[2] ?? 8787)});
  console.log(`fixtures on ${url} (frame host ${frameOrigin})`);
}
