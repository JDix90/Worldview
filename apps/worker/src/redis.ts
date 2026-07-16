import { Redis } from 'ioredis';
import { env } from './env.js';

/** BullMQ blocking connections require maxRetriesPerRequest: null. */
export function createRedis(): Redis {
  return new Redis(env.redisUrl, { maxRetriesPerRequest: null });
}
