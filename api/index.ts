import { handle } from "hono/vercel";
import app from "../src/app.ts";

export const config = {
  runtime: "nodejs20.x",
  maxDuration: 300,
};

export default handle(app);
