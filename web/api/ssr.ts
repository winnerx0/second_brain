// @ts-expect-error - resolved at runtime from the vite build output
import server from '../dist/server/server.js';
import { toNodeHandler } from 'srvx/node';

export const config = {
  maxDuration: 30,
};

const fetchServer = server as {
  fetch: (req: Request) => Response | Promise<Response>;
};

export default toNodeHandler(fetchServer.fetch.bind(fetchServer));
