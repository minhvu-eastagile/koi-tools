import dotenv from "dotenv";
dotenv.config();

import { Common, arweave } from "./common";
import { readFile } from "fs/promises";
import Datastore from "nedb-promises";
import redis, { RedisClient } from "redis";
//@ts-ignore
import kohaku from "@_koi/kohaku";

interface VoteState {
  id: number;
  type: string;
  voted: [];
  stakeAmount: number;
  yays: number;
  nays: number;
  bundlers: any;
  start: number;
  end: number;
}

export const URL_GATEWAY_LOGS = "https://gatewayv2.koi.rocks/logs";
const READ_COOLDOWN = 60000;
let kohakuNextRead = 0;

export class Node extends Common {
  db?: Datastore;
  totalVoted = -1;
  receipts: Array<any> = [];
  redisClient?: RedisClient;

  /**
   * Retrieves the current state in kohaku cache and triggers an update for the next request
   * @param txId Contract whose state to get
   * @returns Latest cached contract state
   */
  getState(txId: string): Promise<any> | any {
    if (process.env.NODE_MODE !== "service") return super.getState(txId);
    let cached;
    try {
      cached = JSON.parse(kohaku.readContractCache(txId));
    } catch {
      // Not in cache
    }
    // If empty, return awaitable promise
    if (!cached) return kohaku.readContract(arweave, txId);
    const now = Date.now();
    if (now > kohakuNextRead) {
      kohakuNextRead = now + READ_COOLDOWN;
      kohaku.readContract(arweave, txId); // Update cache but don't await
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
  getKoiiState(): Promise<any> | any {
    if (process.env.NODE_MODE !== "service") return super.getKoiiState();
    return this.getState(this.contractId);
  }

  /**
   * @returns Koii contract state bypassing cache
   */
  getKoiiStateAwait(): Promise<any> {
    return this.getStateAwait(this.contractId);
  }

  /**
   * Depreciated wrapper for getKoiiState
   */
  getContractState(): Promise<any> | any {
    console.warn("getContractState is depreciated. Use getKoiiState");
    return this.getKoiiState();
  }

  /**
   * Asynchronously load a wallet from a UTF8 JSON file
   * @param file Path of the file to be loaded
   * @returns JSON representation of the object
   */
  async loadFile(file: string): Promise<any> {
    const data = await readFile(file, "utf8");
    return JSON.parse(data);
  }

  /**
   * Loads redis client
   */
  loadRedisClient(): void {
    if (!process.env.REDIS_IP || !process.env.REDIS_PORT) {
      throw Error("CANNOT READ REDIS IP OR PORT FROM ENV");
    } else {
      this.redisClient = redis.createClient({
        host: process.env.REDIS_IP,
        port: parseInt(process.env.REDIS_PORT),
        password: process.env.REDIS_PASSWORD
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
  redisSetAsync(key: any, value: string): Promise<void> {
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
  redisGetAsync(key: any): Promise<string | null> {
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
