// @ts-expect-error - resolved at runtime from the vite build output
import server from '../dist/server/server.js';

export const config = {
  maxDuration: 30,
};

export default async function handler(req: Request): Promise<Response> {
  return (server as { fetch: (req: Request) => Promise<Response> }).fetch(req);
}
