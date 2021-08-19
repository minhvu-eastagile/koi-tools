import dotenv from "dotenv";
dotenv.config();

import { Common, Vote, BundlerPayload, arweave } from "./common";
import { JWKInterface } from "arweave/node/lib/wallet";
import { readFile } from "fs/promises";
import Datastore from "nedb-promises";
import axios, { AxiosResponse } from "axios";
import * as arweaveUtils from "arweave/node/lib/utils";
import redis, { RedisClient } from "redis";
//@ts-ignore
import kohaku from "kohaku";

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
const SERVICE_SUBMIT = "/submit-vote";

let readNextTime = 0;
const readCooldown = 60000;

export class Node extends Common {
  db?: Datastore;
  totalVoted = -1;
  receipts: Array<any> = [];
  redisClient?: RedisClient;

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
   * Loads wallet for node Simulator key from file path and initialize ndb.
   * @param walletFileLocation Wallet key file location
   * @returns Key as an object
   */
  async nodeLoadWallet(
    walletFileLocation: string
  ): Promise<JWKInterface | undefined> {
    const jwk = await this.loadFile(walletFileLocation);
    await this.loadWallet(jwk);
    const voteId = await this._activeVote();
    this.db = Datastore.create({
      filename: "my-db.db",
      autoload: true
    });
    const count = await this.db.count({});
    if (count == 0) {
      const data = {
        totalVoted: voteId,
        receipt: []
      };

      await this.db.insert(data);

      this.totalVoted = data.totalVoted;
    } else {
      const data: Array<any> = await this.db.find({});
      this.totalVoted = data[0].totalVoted;
      this.receipts.push(data[0].receipt);
    }
    return this.wallet;
  }

  /**
   * Submit vote to bundle server or direct to contract
   * @param arg Object with direct, voteId, and useVote
   * @returns Transaction ID
   */
  async vote(arg: Vote): Promise<any> {
    const userVote: any = await this.validateData(arg.voteId);
    if (userVote == null) {
      this.totalVoted += 1;
      await this._db();
      return { message: "VoteTimePassed" };
    }

    const input = {
      function: "vote",
      voteId: arg.voteId,
      userVote: userVote
    };

    let receipt;
    let tx;
    if (arg.direct) tx = await this._interactWrite(input);
    else {
      const caller = await this.getWalletAddress();

      // Vote must be a string when indirect voting through bundler
      input.userVote = userVote.toString();

      const payload: BundlerPayload = {
        vote: input,
        senderAddress: caller
      };

      receipt = await this._bundlerNode(payload);
    }

    if (tx) {
      this.totalVoted += 1;
      await this._db();
      return { message: "justVoted" };
    }

    if (!receipt) return null;

    if (this.db !== undefined && receipt.status === 200) {
      if (receipt.data.message == "success") {
        this.totalVoted += 1;
        const data = receipt.data.receipt;
        const id = await this._db();
        await this.db.update({ _id: id }, { $push: { receipt: data } });
        this.receipts.push(data);
        return { message: "success" };
      } else if (receipt.data.message == "duplicate") {
        this.totalVoted += 1;
        await this._db();
        return { message: "duplicatedVote" };
      }
    } else {
      this.totalVoted += 1;
      await this._db();
      return { message: receipt.data.message };
    }

    // Status 200, but message doesn't match.
    return null;
  }

  /**
   * propose a tafficLog for vote
   * @param arg
   * @returns object arg.gateway(trafficlog original gateway id) and arg.stakeAmount(min required stake to vote)
   */
  async submitTrafficLog(arg: any): Promise<string> {
    const TLTxId = await this._storeTrafficLogOnArweave(arg.gateWayUrl);

    const input = {
      function: "submitTrafficLog",
      gateWayUrl: arg.gateWayUrl,
      batchTxId: TLTxId,
      stakeAmount: arg.stakeAmount
    };
    return this._interactWrite(input);
  }

  /**
   * Triggers proposal rank in contract
   * @returns Transaction ID
   */
  rankProposal(): Promise<string> {
    const input = {
      function: "rankProposal"
    };
    return this._interactWrite(input);
  }

  /**
   * Interact with contract to add the votes
   * @param arg Batch data
   * @returns Transaction ID
   */
  batchAction(arg: any): Promise<string> {
    // input object that pass to contract
    const input = {
      function: "batchAction",
      batchFile: arg.batchFile,
      voteId: arg.voteId,
      bundlerAddress: arg.bundlerAddress
    };

    // interact with contract function batchAction which adds all votes and update the state
    return this._interactWrite(input);
  }

  /**
   * Propose a stake slashing
   * @returns
   */
  async proposeSlash(): Promise<void> {
    const state = await this.getContractState();
    const votes = state.votes;
    const currentTrafficLogs =
      state.stateUpdate.trafficLogs.dailyTrafficLog.filter(
        (proposedLog: {
          block: number;
          proposedLogs: [];
          isRanked: boolean;
          isDistributed: boolean;
        }) => proposedLog.block == state.stateUpdate.trafficLogs.open
      );
    for (const proposedLogs of currentTrafficLogs) {
      const currentProposedLogsVoteId = proposedLogs.voteId;
      for (let i = 0; i < this.receipts.length - 1; i++) {
        if (this.receipts[i].vote.vote.voteId === currentProposedLogsVoteId) {
          const vote = votes[currentProposedLogsVoteId];
          if (!vote.voted.includes(this.wallet)) {
            const input = {
              function: "proposeSlash",
              receipt: this.receipts[i]
            };
            await this._interactWrite(input);
          }
        }
      }
    }
  }

  /**
   * Read contract latest state
   * @returns Contract
   */
  getContractState(): Promise<any> {
    if (process.env.NODE_MODE !== "service") return super.getContractState();

    const currTime = Date.now();
    if (readNextTime > currTime)
      // Don't fetch new TXs if on cooldown
      return kohaku.readContract(
        arweave,
        this.contractId,
        kohaku.getCacheHeight()
      );

    readNextTime = currTime + readCooldown;
    return kohaku.readContract(arweave, this.contractId);
  }

  /**
   * Triggers distribute reward function
   * @returns Transaction ID
   */
  async distributeDailyRewards(): Promise<string> {
    const input = {
      function: "distributeRewards"
    };
    return this._interactWrite(input);
  }

  /**
   * Validate traffic log by comparing traffic log from gateway and arweave storage
   * @param voteId Vote id which is belongs for specific proposalLog
   * @returns Whether data is valid
   */
  async validateData(voteId: number): Promise<boolean | null> {
    const state: any = await this.getContractState();
    const trafficLogs = state.stateUpdate.trafficLogs;
    const currentTrafficLogs = trafficLogs.dailyTrafficLog.find(
      (trafficLog: any) => trafficLog.block === trafficLogs.open
    );
    const proposedLogs = currentTrafficLogs.proposedLogs;
    const proposedLog = proposedLogs.find((log: any) => log.voteId === voteId);
    // lets assume we have one gateway id for now.
    //let gateWayUrl = proposedLog.gatWayId;

    if (proposedLog === undefined) return null;

    const gatewayTrafficLogs = await this._getTrafficLogFromGateWay(
      URL_GATEWAY_LOGS
    );
    const gatewayTrafficLogsHash = await this._hashData(
      gatewayTrafficLogs.data.summary
    );

    const bundledTrafficLogs = (await arweave.transactions.getData(
      proposedLog.TLTxId,
      { decode: true, string: true }
    )) as string;

    const bundledTrafficLogsParsed = JSON.parse(bundledTrafficLogs);
    const bundledTrafficLogsParsedHash = await this._hashData(
      bundledTrafficLogsParsed
    );

    return gatewayTrafficLogsHash === bundledTrafficLogsParsedHash;
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

  // Private functions
  /**
   * Read the data and update
   * @returns Database document ID
   */
  private async _db(): Promise<string | null> {
    if (this.db === undefined) return null;

    const dataB: any = await this.db.find({});
    const id: string = dataB[0]._id;
    const receipt = dataB[0].receipt; // dataB is forced to any to allow .receipt
    await this.db.update(
      { _id: id },
      {
        totalVoted: this.totalVoted,
        receipt: receipt
      }
    );
    return id;
  }

  /**
   * Get the latest state
   * @returns  Active vote Id
   */
  private async _activeVote(): Promise<number> {
    const state = await this.getContractState();
    const activeVotes = state.votes.find(
      (vote: VoteState) => vote.end == state.stateUpdate.trafficLogs.close
    );
    if (activeVotes !== undefined) {
      return activeVotes.id - 1;
    } else {
      return state.votes.length - 1;
    }
  }

  /**
   * Submits a payload to server
   * @param payload Payload to be submitted
   * @returns Result as a promise
   */
  private async _bundlerNode(
    payload: BundlerPayload
  ): Promise<AxiosResponse<any> | null> {
    const sigResult = await this.signPayload(payload);
    return sigResult !== null
      ? await axios.post(this.bundlerUrl + SERVICE_SUBMIT, sigResult)
      : null;
  }

  /**
   * Get traffic logs from gateway
   * @param path Gateway url
   * @returns Result as a promise
   */
  private _getTrafficLogFromGateWay(path: string): Promise<any> {
    return axios.get(path);
  }

  /**
   *
   * @param gateWayUrl
   * @returns
   */
  private async _storeTrafficLogOnArweave(
    gateWayUrl: string
  ): Promise<string | null> {
    const trafficLogs = await this._getTrafficLogFromGateWay(gateWayUrl);
    return await this.postData(trafficLogs.data.summary);
  }

  /**
   * Read contract latest state
   * @param data Data to be hashed
   * @returns Hex string
   */
  private async _hashData(data: any): Promise<string> {
    const dataInString = JSON.stringify(data);
    const dataIn8Array = arweaveUtils.stringToBuffer(dataInString);
    const hashBuffer = await arweave.crypto.hash(dataIn8Array);
    const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
    const hashHex = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""); // convert bytes to hex string
    return hashHex;
  }
}

module.exports = { Node, URL_GATEWAY_LOGS };
