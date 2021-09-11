import { Common } from "./common";

export class Web extends Common {
  /**
   * Get top contents of user
   * @param attention_id ID of the attention contract to apply views and attention from
   * @returns Array of user contents
   */
  async myContent(): Promise<Array<any> | null> {
    if (!this.address) return null;

    // Get array of my awaitable NFT states
    const contentViewProms = [];
    const attentionState = await this.getState("attention");
    for (const txId in attentionState.nfts[this.address])
      contentViewProms.push(this.getNftState(txId));

    // Process NFTs simultaneously then return
    return await Promise.all(contentViewProms);
  }
}

module.exports = { Web };
