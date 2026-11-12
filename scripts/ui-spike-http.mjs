/** Kept separate from Docker setup so the actual request boundary can be tested
 * with byte chunks in memory, without a listener or a live Beads database.
 */
export function createSpikeRequestHandler(api) {
  return async (request, response) => {
    try {
      if (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:3185') {
        response.writeHead(403).end(); return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      // Decode the complete byte sequence once: UTF-8 characters can span chunks.
      const body = Buffer.concat(chunks, size).toString('utf8');
      const result = api.handle(request.method, request.url, body ? JSON.parse(body) : undefined);
      response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result.body, null, 2));
    } catch { response.writeHead(400).end(); }
  };
}
