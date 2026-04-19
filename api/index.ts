import app from "../src/app.ts";

export const config = {
  maxDuration: 300,
};

export default async function handler(req: Request): Promise<Response> {
  return app.fetch(req);
}
