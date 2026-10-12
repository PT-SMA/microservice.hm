import { Dialect } from "sequelize";

export const REDIS_URL = Deno.env.get("REDIS_URL") ?? "redis://localhost:6379";
export const PORT = Number(Deno.env.get("PORT") ?? "8888");

export const DB_DIALECT = (Deno.env.get("DB_DIALECT") ?? "postgres") as Dialect;
export const DB_HOST = Deno.env.get("DB_HOST") ?? "localhost";
export const DB_PORT = Number(Deno.env.get("DB_PORT") ?? "5432");
export const DB_NAME = Deno.env.get("DB_NAME") ?? "postgres";
export const DB_USER = Deno.env.get("DB_USER") ?? "postgres";
export const DB_PASSWORD = Deno.env.get("DB_PASSWORD") ?? "";
export const DB_POOL_MAX = Number(Deno.env.get("DB_POOL_MAX") ?? "5");
export const DB_ALTER = Deno.env.get("DB_ALTER") === "true";
