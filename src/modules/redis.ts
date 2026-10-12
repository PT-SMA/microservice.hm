import { createClient } from "redis";
import { REDIS_URL } from "consts";

export const redisClient = createClient({
  url: REDIS_URL,
});
