import { Queue } from "bullmq";
import { connection } from "../config/redis.js";

export const splitQueue = new Queue("splitQueue", { connection });
