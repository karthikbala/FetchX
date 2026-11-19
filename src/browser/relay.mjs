// The browser's only way out. A local CONNECT proxy that the browser is pointed
// at: it opens a tunnel only to a host:443 the gateway has admitted and pinned,
// either when the page requested it (hooks.admit) or here through admitHost
// (redirect hops the browser's interception does not see), through the
// attempt's route proxy, and meters every byte. TLS stays end to end between the browser and the site; the relay never
// sees page content. Plain-HTTP proxy requests are refused.
import http from 'node:http';
import net from 'node:net';
import {GatewayError} from '../policy.mjs';
import {createMeter, meteredBytes, openProxyTunnel} from '../fetch/transport.mjs';

// pins: Map<hostname, {destination, permits}> shared with the admission hook.
// Proxy answers worth reporting instead of a generic browser failure.
export const TUNNEL_FAILURES = new Set(['provider_account_rejected', 'provider_target_refused', 'source_unreachable']);

export async function startRelay({pins, admitHost = null, proxy = null, maxBytes, deadline, onConnect = async () => {},
  dial = destination => net.connect({host: destination.address, port: 443})}) {
  const sockets = new Set();
  const pending = new Set();
  const meter = createMeter();
  let directBytes = 0;
  let error = null;
  let closed = false;
  let connections = 0;
  const track = socket => {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const stop = code => {
    error ??= code;
    for (const socket of sockets) socket.destroy();
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(403, {connection: 'close'});
    res.end();
  });
  server.on('connection', track);
  server.on('upgrade', (_req, socket) => socket.destroy());

  const pump = (from, to) => from.on('data', chunk => {
    if (!proxy) {
      directBytes += chunk.length;
      if (directBytes > maxBytes) return stop('too_large');
    }
    if (!to.write(chunk)) {
      from.pause();
      to.once('drain', () => from.resume());
    }
  });

  server.on('connect', (req, client, head) => {
    const work = (async () => {
      client.pause();
      try {
        const match = /^([a-z0-9.-]{1,253}):443$/i.exec(req.url ?? '');
        if (closed || error || Date.now() >= deadline || head.length || !match) throw new GatewayError('browser_connect_rejected');
        const host = match[1].toLowerCase();
        let pin = pins.get(host);
        if ((!pin || pin.permits <= 0) && admitHost) pin = await admitHost(host).catch(() => null);
        if (!pin || pin.permits <= 0) throw new GatewayError('browser_connect_rejected');
        pin.permits--;
        await onConnect(pin.destination);
        if (closed || error || client.destroyed || Date.now() >= deadline) throw new GatewayError('browser_connect_rejected');
        connections++;
        let remote;
        if (proxy) {
          remote = await openProxyTunnel(proxy, pin.destination,
            {maxBytes, timeoutMs: Math.max(1, deadline - Date.now())}, meter);
        } else {
          remote = await new Promise((resolve, reject) => {
            const socket = track(dial(pin.destination));
            const timer = setTimeout(() => {
              socket.destroy();
              reject(new GatewayError('browser_connect_failed'));
            }, Math.max(1, deadline - Date.now()));
            socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
            socket.once('error', () => { clearTimeout(timer); reject(new GatewayError('browser_connect_failed')); });
          });
        }
        track(remote);
        remote.on('error', failure => stop(failure.code === 'too_large' ? 'too_large' : 'browser_transport_failed'));
        if (closed || error || client.destroyed) return remote.destroy();
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        pump(client, remote);
        pump(remote, client);
        remote.on('close', () => client.destroy());
        client.on('close', () => remote.destroy());
        client.resume();
      } catch (failure) {
        if (failure.code === 'too_large') stop('too_large');
        else if (TUNNEL_FAILURES.has(failure.code)) error ??= failure.code;
        else if (failure.code !== 'browser_connect_rejected') error ??= 'browser_connect_failed';
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      }
    })();
    pending.add(work);
    work.finally(() => pending.delete(work));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => stop('browser_deadline'), Math.max(1, deadline - Date.now()));
  timer.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get bytes() { return proxy ? meteredBytes(meter) : directBytes; },
    get error() { return error; },
    get connections() { return connections; },
    async close() {
      closed = true;
      clearTimeout(timer);
      const closing = new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}
