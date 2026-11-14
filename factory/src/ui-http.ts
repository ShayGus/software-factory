import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpikeResponse } from './ui-spike.js';
import { uiCss } from './ui-style.js';

export interface HttpApi { handle(method: string, path: string, body?: unknown): SpikeResponse }
export function createToolkitRequestHandler(api: HttpApi, options: { port?: number; trustedOrigins?: string[] } = {}) {
  const authority = `127.0.0.1:${options.port ?? 3185}`;
  const origins = [new URL(`http://${authority}`).origin, ...(options.trustedOrigins ?? [])];
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer' };
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, { ...headers, 'Content-Type': contentType });
      response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : String(body));
    };
    const error = (status: number, message: string) => send(status, { error: { code: 'validation', message, paths: [], externalReferences: [] } });
    try {
      const origin = request.headers.host ? origins.find(value => new URL(value).host === request.headers.host) : origins[0];
      if (!origin ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') { error(403, 'local_origin_required'); return; }
      const asset = request.url?.split('?')[0];
      if (request.method === 'GET' && asset?.startsWith('/assets/')) {
        if (asset === '/assets/ui.css') { send(200, uiCss, 'text/css; charset=utf-8'); return; }
        if (asset === '/assets/ui-client.js' || asset === '/assets/ui-edit.js') {
          const file = asset === '/assets/ui-client.js' ? './ui-client.js' : './ui-edit.js';
          send(200, readFileSync(new URL(file, import.meta.url), 'utf8'), 'text/javascript; charset=utf-8'); return;
        }
        error(404, 'asset_not_found'); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) { error(413, 'request_too_large'); return; }
        chunks.push(bytes);
      }
      if (request.method === 'POST' && request.headers['content-type'] && !request.headers['content-type'].startsWith('application/json')) {
        error(415, 'json_content_type_required'); return;
      }
      const body = Buffer.concat(chunks, size).toString('utf8');
      const result = api.handle(request.method ?? 'GET', request.url ?? '/', body ? JSON.parse(body) : undefined);
      send(result.status, result.body, result.contentType);
    } catch (cause) { error(400, cause instanceof SyntaxError ? 'invalid_json' : 'invalid_request'); }
  };
}
