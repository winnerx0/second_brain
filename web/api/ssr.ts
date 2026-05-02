// @ts-expect-error - resolved at runtime from the vite build output
import server from '../dist/server/server.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = {
  maxDuration: 30,
};

const fetchServer = server as {
  fetch: (req: Request) => Promise<Response>;
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }

  let body: Buffer | undefined;
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length) body = Buffer.concat(chunks);
  }

  const webReq = new Request(url, {
    method: req.method,
    headers,
    body,
  });

  const webRes = await fetchServer.fetch(webReq);

  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));

  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
