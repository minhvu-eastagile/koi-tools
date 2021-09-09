import { Common } from "./common";

export class Web extends Common {
  /**
   * Get top contents of user
   * @returns Array of user contents
   */
  async myContent(): Promise<Array<any>> {
    // Get nft records
    const state: any = await this.getContractState();
    const registerRecords: any = state.registeredRecord;

    // Get array of my awaitable NFTs
    const contentViewProms = [];
    for (const txId in registerRecords)
      if (registerRecords[txId] === this.address)
        contentViewProms.push(this.contentView(txId));

    // Process NFTs simultaneously then return
    return await Promise.all(contentViewProms);
  }
}

module.exports = { Web };
