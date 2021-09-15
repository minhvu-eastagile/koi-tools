"use strict";

const kcommon = require("../dist/web");
const ktools = new kcommon.Web();

test("My content", async () => {
    ktools.setWallet("WL32qc-jsTxCe8m8RRQfS3b3MacsTQySDmJklvtkGFc");
    const myNfts = await ktools.myContent();
    expect(myNfts.length).toBeGreaterThan(7);
});