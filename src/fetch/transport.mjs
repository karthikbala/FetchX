// One HTTP exchange with a site, directly or through a CONNECT proxy, to an
// address that destination.mjs has already checked (DNS pinning). Every byte
// in both directions is metered, including the CONNECT exchange, so proxy
// traffic is known exactly and capped.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {Duplex} from 'node:stream';
import {gunzipSync, brotliDecompressSync, inflateSync} from 'node:zlib';
import {GatewayError, fail} from '../policy.mjs';
import {urlPort} from './destination.mjs';

const PROXY_HEADER_LIMIT = 16384;
const SAFE_CAUSES = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ETIMEOUT', 'EAI_AGAIN', 'ECONNREFUSED',
  'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER', 'HPE_INVALID_CONSTANT', 'HPE_HEADER_OVERFLOW']);

// Only reviewed runtime codes ever leave this module; never messages.
export function safeCause(error) {
  for (const code of [error?.cause_code, error?.code, error?.cause?.code]) if (SAFE_CAUSES.has(code)) return code;
  return null;
}

function transportError(code, cause) {
  const error = new GatewayError(code, 502);
  error.cause_code = safeCause(cause);
  return error;
}

function failureFor(cause) {
  if (cause instanceof GatewayError) return cause;
  const code = safeCause(cause);
  if (code && /CERT|SSL|TLS|SELF_SIGNED|ISSUER/.test(code)) return transportError('source_tls_failed', cause);
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return transportError('source_unreachable', cause);
  return transportError('source_transport_unknown', cause);
}

export function decodeBody(encoded, encoding, {maxDecodedBytes, maxExpansionRatio = 100}) {
  const code = (encoding ?? 'identity').trim().toLowerCase();
  let decoded;
  try {
    if (code === 'identity' || code === '') decoded = encoded;
    else if (code === 'gzip' || code === 'x-gzip') decoded = gunzipSync(encoded, {maxOutputLength: maxDecodedBytes});
    else if (code === 'br') decoded = brotliDecompressSync(encoded, {maxOutputLength: maxDecodedBytes});
    else if (code === 'deflate') decoded = inflateSync(encoded, {maxOutputLength: maxDecodedBytes});
    else fail('content_encoding_unsupported', 502);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'content_decoding_failed', 502);
  }
  if (decoded.length > maxDecodedBytes) fail('too_large', 502);
  if (decoded.length > Math.max(1024, encoded.length * maxExpansionRatio)) fail('decompression_ratio_limit', 502);
  return decoded;
}

// A meter counts bytes in both directions. `uncertain` is sticky: once a write
// cannot be confirmed, the total is a lower bound, not an exact count.
export function createMeter() {
  return {bytes: 0, uncertain: false, pendingWrites: 0, providerStatus: null};
}

function meteredWrite(socket, bytes, encoding, meter, callback) {
  const size = Buffer.byteLength(bytes, encoding);
  meter.pendingWrites++;
  let settled = false;
  const done = error => {
    if (settled) return;
    settled = true;
    meter.pendingWrites--;
    if (error) meter.uncertain = true;
    callback(error);
  };
  try {
    socket.write(bytes, encoding, done);
    meter.bytes += size;
  } catch (error) {
    done(error);
  }
}

export const meteredBytes = meter => (meter.uncertain || meter.pendingWrites > 0 ? null : meter.bytes);

class MeteredSocket extends Duplex {
  constructor(socket, meter, limit) {
    super();
    Object.assign(this, {socket, meter, limit});
    socket.on('data', chunk => {
      meter.bytes += chunk.length;
      if (meter.bytes > limit) {
        this.destroy(new GatewayError('too_large', 502));
        return;
      }
      if (!this.push(chunk)) socket.pause();
    });
    socket.on('end', () => this.push(null));
    socket.on('error', error => {
      meter.uncertain = true;
      this.destroy(error);
    });
    socket.on('close', () => this.destroy());
  }

  _read() { this.socket.resume(); }

  _write(chunk, encoding, callback) {
    // A refused write never reaches the network, so it is not metered.
    if (this.meter.bytes + chunk.length > this.limit) return callback(new GatewayError('too_large', 502));
    if (this.socket.destroyed || !this.socket.writable) {
      this.meter.uncertain = true;
      return callback(new GatewayError('source_transport_unknown', 502));
    }
    meteredWrite(this.socket, chunk, encoding, this.meter, callback);
  }

  _destroy(error, callback) {
    if (this.meter.pendingWrites > 0) this.meter.uncertain = true;
    this.socket.destroy();
    callback(error);
  }
}

function connectSocket({host, port}, connect, signal) {
  return new Promise((resolve, reject) => {
    const socket = connect({host, port});
    const abort = () => finish(new GatewayError('source_timeout', 504));
    const finish = (error, value) => {
      signal?.removeEventListener('abort', abort);
      socket.removeListener('error', onError);
      socket.removeListener('connect', onConnect);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(value);
    };
    const onError = error => finish(failureFor(error));
    const onConnect = () => finish(null, socket);
    socket.once('error', onError);
    socket.once('connect', onConnect);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once: true});
  });
}

// A refused CONNECT: our account (401/402/407), the exit could not reach the
// site (502/503/504), or the provider will not carry this host (any other).
const tunnelFailure = status => [401, 402, 407].includes(status) ? 'provider_account_rejected'
  : [502, 503, 504].includes(status) ? 'source_unreachable' : 'provider_target_refused';

// Opens a CONNECT tunnel to the pinned address. Proxy refusals are reported as
// provider faults, never as site behaviour.
export async function openProxyTunnel(proxy, destination, {maxBytes, signal, timeoutMs}, meter,
  {connect = net.connect} = {}) {
  const upstream = new URL(proxy.url);
  if (upstream.protocol !== 'http:' || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    fail('proxy_configuration_invalid', 503);
  }
  const port = urlPort(destination.url);
  const target = (destination.family === 6 ? `[${destination.address}]` : destination.address) + ':' + port;
  const socket = await connectSocket({host: upstream.hostname, port: Number(upstream.port) || 80}, connect, signal)
    .catch(error => {
      const failure = new GatewayError(safeCause(error) === 'ECONNREFUSED' ? 'proxy_connect_refused' : 'proxy_connect_failed', 502);
      failure.cause_code = safeCause(error);
      failure.dispatched = false;
      throw failure;
    });
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => finish(new GatewayError('proxy_connect_failed', 502)), timeoutMs);
    const finish = (error, tunnel) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(tunnel);
    };
    const onError = error => finish(transportError('proxy_connect_failed', error));
    const onData = chunk => {
      meter.bytes += chunk.length;
      header = Buffer.concat([header, chunk.subarray(0, Math.max(0, PROXY_HEADER_LIMIT + 1 - header.length))]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) {
        if (header.length > PROXY_HEADER_LIMIT) finish(new GatewayError('proxy_response_invalid', 502));
        return;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(header.toString('latin1'))?.[1]) || null;
      meter.providerStatus = status;
      if (status !== 200) {
        const failure = new GatewayError(tunnelFailure(status), 502);
        failure.provider_status = status;
        failure.dispatched = false;
        return finish(failure);
      }
      // The proxy must wait for our first byte; anything extra is not trusted.
      if (header.length !== end + 4) return finish(new GatewayError('proxy_response_invalid', 502));
      socket.pause();
      finish(null, new MeteredSocket(socket, meter, maxBytes));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    const auth = upstream.username || upstream.password
      ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(upstream.username) + ':'
        + decodeURIComponent(upstream.password)).toString('base64') + '\r\n'
      : '';
    meteredWrite(socket, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`, 'latin1', meter, error => {
      if (error) finish(transportError('proxy_connect_failed', error));
    });
  });
}

async function openDirect(destination, {maxBytes, signal}, meter, {connect = net.connect} = {}) {
  const socket = await connectSocket({host: destination.address, port: urlPort(destination.url)}, connect, signal);
  return new MeteredSocket(socket, meter, maxBytes);
}

// Sends one request and reads one response. Redirects are the caller's job.
// limits: {timeoutMs, maxBodyBytes, maxWireBytes}
export async function exchange(request, destination, limits, {proxy = null, connect, tlsConnect = tls.connect} = {}) {
  const meter = createMeter();
  const controller = new AbortController();
  const secure = destination.url.protocol === 'https:';
  const agentOptions = {keepAlive: false};
  const agent = secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
  let socket;
  agent.createConnection = (_options, callback) => {
    const tunnelOptions = {maxBytes: limits.maxWireBytes, signal: controller.signal, timeoutMs: limits.timeoutMs};
    const opened = proxy
      ? openProxyTunnel(proxy, destination, tunnelOptions, meter, {connect})
      : openDirect(destination, tunnelOptions, meter, {connect});
    opened.then(stream => {
      socket = stream;
      if (!secure) return callback(null, stream);
      callback(null, tlsConnect({socket: stream, servername: destination.url.hostname, rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1']}));
    }).catch(callback);
  };
  const requestImpl = secure ? https.request : http.request;
  try {
    return await new Promise((resolve, reject) => {
      let finished = false;
      let total = 0;
      let req;
      const timer = setTimeout(() => finish(new GatewayError('source_timeout', 504)), limits.timeoutMs);
      const finish = (error, response) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        controller.abort();
        socket?.destroy();
        if (error) {
          error.wire_bytes = meteredBytes(meter);
          error.provider_status ??= meter.providerStatus;
          // Bytes left the machine: the site may have seen the request.
          error.dispatched ??= meter.bytes > 0;
          req?.destroy();
          reject(error);
        } else resolve(response);
      };
      try {
        req = requestImpl(destination.url, {
          method: request.method,
          headers: request.headers,
          agent,
          lookup: (_host, options, callback) => (options?.all
            ? callback(null, [{address: destination.address, family: destination.family}])
            : callback(null, destination.address, destination.family)),
          servername: destination.url.hostname,
          rejectUnauthorized: true,
          maxHeaderSize: 32768,
        }, res => {
          const parts = [];
          res.on('data', chunk => {
            total += chunk.length;
            if (total > limits.maxBodyBytes) {
              finish(new GatewayError('too_large', 502));
              return res.destroy();
            }
            parts.push(chunk);
          });
          res.on('aborted', () => finish(new GatewayError('source_body_incomplete', 502)));
          res.on('error', () => finish(new GatewayError('source_body_incomplete', 502)));
          res.on('end', () => finish(null, {
            status: res.statusCode,
            headers: res.headers,
            encoded: Buffer.concat(parts),
            wire_bytes: meteredBytes(meter),
            provider_status: meter.providerStatus,
          }));
        });
      } catch (error) {
        return finish(failureFor(error));
      }
      req.on('error', error => finish(failureFor(error)));
      req.end(request.body ?? undefined);
    });
  } finally {
    agent.destroy();
  }
}

