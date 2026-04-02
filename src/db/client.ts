import { drizzle } from "drizzle-orm/bun-sql";
import { config } from "../config.ts";

export const db = drizzle(config.DATABASE_URL);
