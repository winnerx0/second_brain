import server from "../dist/server/server.js";

export const config = {
  maxDuration: 30,
};

export default async function handler(req: Request): Promise<Response> {
  return server.fetch(req);
}
