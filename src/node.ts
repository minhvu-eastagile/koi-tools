import dotenv from "dotenv";
dotenv.config();

import { Common, arweave } from "./common";
import { readFile } from "fs/promises";
import redis, { RedisClient } from "redis";
//@ts-ignore
import kohaku from "@_koi/kohaku";

export const URL_GATEWAY_LOGS = "https://gatewayv2.koi.rocks/logs";
const READ_COOLDOWN = 60000;
let kohakuNextRead = 0;
interface redisConfig {
  redis_ip?: string;
  redis_port?: number;
  redis_password?: string;
}

export class Node extends Common {
  totalVoted = -1;
  receipts: Array<unknown> = [];
  redisClient?: RedisClient;

  /**
   * Retrieves the current state in kohaku cache and triggers an update for the next request
   * @param txId Contract whose state to get
   * @returns Latest cached contract state
   */
  getState(txId: string): Promise<unknown> | any {
    if (process.env.NODE_MODE !== "service") return super.getState(txId);
    let cached;
    try {
      cached = JSON.parse(kohaku.readContractCache(txId));
    } catch {
      // Not in cache
    }
    // If empty, return awaitable promise
    const now = Date.now();
    if (!cached) {
      kohakuNextRead = now + READ_COOLDOWN;
      return kohaku.readContract(arweave, txId);
    }
    if (now > kohakuNextRead) {
      kohakuNextRead = now + READ_COOLDOWN;
      // Update cache but don't await
      kohaku.readContract(arweave, txId).catch((e: Error) => {
        console.error("Koii SDK error while updating state async:", e.message);
      });
    }
    return cached;
  }

  /**
   * Retrieves the current state bypassing cache
   * @param txId Contract whose state to get
   * @returns Latest contract state
   */
  getStateAwait(txId: string): any {
    kohakuNextRead += Date.now() + READ_COOLDOWN;
    return kohaku.readContract(arweave, txId);
  }

  /**
   * @returns Cached Koii contract state
   */
  getKoiiState(): Promise<unknown> | any {
    if (process.env.NODE_MODE !== "service") return super.getKoiiState();
    return this.getState(this.contractId);
  }

  /**
   * @returns Koii contract state bypassing cache
   */
  getKoiiStateAwait(): Promise<unknown> {
    return this.getStateAwait(this.contractId);
  }

  /**
   * Depreciated wrapper for getKoiiState
   */
  getContractState(): Promise<unknown> | any {
    console.warn("getContractState is depreciated. Use getKoiiState");
    return this.getKoiiState();
  }

  /**
   * Asynchronously load a wallet from a UTF8 JSON file
   * @param file Path of the file to be loaded
   * @returns JSON representation of the object
   */
  async loadFile(file: string): Promise<unknown> {
    const data = await readFile(file, "utf8");
    return JSON.parse(data);
  }

  /**
   * Loads redis client
   */
  loadRedisClient(config: redisConfig): void {
    if (
      ((!process.env.REDIS_IP || !process.env.REDIS_PORT) &&
        !config.redis_ip) || !config.redis_port
    ) {
      throw Error("CANNOT READ REDIS IP OR PORT FROM ENV");
    } else {
      this.redisClient = redis.createClient({
        host: process.env.REDIS_IP || config.redis_ip,
        port: parseInt(process.env.REDIS_PORT as string) || config.redis_port,
        password: process.env.REDIS_PASSWORD || config.redis_password
      });

      this.redisClient.on("error", function (error) {
        console.error("redisClient " + error);
      });
    }
  }

  /**
   * Store data in Redis async
   * @param key Redis key of data
   * @param value String to store in redis
   * @returns
   */
  redisSetAsync(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.redisClient === undefined) reject("Redis not connected");
      else
        this.redisClient.set(key, value, (err) => {
          err ? reject(err) : resolve();
        });
    });
  }

  /**
   * Get data from Redis async
   * @param key Redis key of data
   * @returns Data as a string, null if no such key exists
   */
  redisGetAsync(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (this.redisClient === undefined) reject("Redis not connected");
      else
        this.redisClient.get(key, (err, res) => {
          err ? reject(err) : resolve(res);
        });
    });
  }
}

module.exports = { Node, URL_GATEWAY_LOGS };
