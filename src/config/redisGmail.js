import Redis from "ioredis";
import { connection } from "../config/redis.js";

const redisGmail = new Redis({
    host: connection.host,
    port: connection.port,
    retryStrategy: connection.retryStrategy,
    lazyConnect: true,
});

redisGmail.on("error", (err) => console.error("[REDIS-GMAIL] Error:", err.message));

export default redisGmail;