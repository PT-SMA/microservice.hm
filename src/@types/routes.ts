import { Hono } from "hono";
import { redisClient } from "modules";
import { TModelInstances } from "./models.ts";

export type NodeRedis = typeof redisClient;

export type AppEnv = {
  Variables: {
    redisClient: NodeRedis;
    models: TModelInstances;
  };
};

/**
 * Every file under `src/routes` default-exports one of these; the Router
 * mounts it at `/api/{path-minus-extension}`.
 */
export type RouteFactory = (models: TModelInstances) => Hono<AppEnv>;

export type PostEquipmentBody = {
  latitude: number;
  longitude: number;
  type: string;
  hull_number: string;
  checkDist?: boolean;
};

export type RedisEquipmentRadius = {
  member: string;
  distance?: string | undefined;
  hash?: number | undefined;
  coordinates?:
    | {
      longitude: number;
      latitude: number;
    }
    | undefined;
};
