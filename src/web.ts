import { Common } from "./common";

export class Web extends Common {
  /**
   * Get top contents of user
   * @returns Array of user contents
   */
  async myContent(): Promise<Array<any>> {
    // Get nft records
    const state: any = await this.getContractState();
    const registerRecords = state.registeredRecord;

    // Get array of my awaitable NFTs
    const contentViewProms = registerRecords.reduce(
      (accu: any[], txId: string) => {
        if (registerRecords[txId] === this.address)
          accu.push(this.contentView(txId, state));
      },
      []
    );

    // Process NFTs simultaneously then return
    return await Promise.all(contentViewProms);
  }
}

module.exports = { Web };
