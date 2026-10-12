import { createClient } from "redis";
import { REDIS_URL } from "consts";
import type { HourMeterPublisher } from "types";

/**
 * `disableOfflineQueue`: while Redis is unreachable a command fails at once
 * instead of queueing. This service publishes a fresh reading every second;
 * queueing would grow memory for the whole outage and then replay a burst of
 * stale readings onto `hour-meter:update` when Redis came back. Dropped
 * readings cost nothing: the next one supersedes them.
 */
const options = {
  url: REDIS_URL,
  pingInterval: 3000,
  disableOfflineQueue: true,
};

/** Commands (the `hour-meter:state` hash). */
export const redisClient = createClient(options);

/**
 * Publishes only. NEVER call `subscribe()` on this client or the one above:
 * under RESP2 a subscribed connection rejects every other command, which is
 * how microservice.tracker once lost all its publishes (its CLAUDE.md).
 */
export const redisPubClient = redisClient.duplicate(options);

/**
 * The only client `subscribe()` may be called on (`hour-meter:command`).
 * node-redis subscribes again by itself after a reconnect.
 */
export const redisSubscriberClient = redisClient.duplicate(options);

/**
 * Listeners go on at creation, before any `connect()`. A node-redis client
 * emits `'error'` on every failed (re)connect, and an `'error'` event with no
 * listener is thrown — fatal to the process. Logged once per outage: the
 * client retries on its own every few hundred ms.
 */
for (
  const [label, client] of [
    ["Redis", redisClient],
    ["Redis publisher", redisPubClient],
    ["Redis subscriber", redisSubscriberClient],
  ] as const
) {
  let down = false;
  client.on("error", (err: unknown) => {
    if (down) return;
    down = true;
    console.error(
      `${label} error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  client.on("ready", () => {
    if (down) console.log(`${label} is back`);
    down = false;
  });
}

/** The production `HourMeterPublisher`. */
export const redisPublisher: HourMeterPublisher = {
  publish: (channel, message) => redisPubClient.publish(channel, message),
  replaceHash: (key, fields) =>
    redisClient.multi().del(key).hSet(key, fields).exec(),
  mergeHash: (key, fields) => redisClient.hSet(key, fields),
};
