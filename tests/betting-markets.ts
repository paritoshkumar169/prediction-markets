import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BettingMarkets } from "../target/types/betting_markets";
import { 
  createMint, 
  createAccount, 
  mintTo, 
  getAccount, 
  TOKEN_PROGRAM_ID 
} from "@solana/spl-token";
import { expect } from "chai";

describe("betting-markets", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.bettingMarkets as Program<BettingMarkets>;
  const provider = anchor.AnchorProvider.env();

  let mint: anchor.web3.PublicKey;
  let globalState: anchor.web3.PublicKey;
  let authority = anchor.web3.Keypair.generate();
  let user1 = anchor.web3.Keypair.generate();
  let user2 = anchor.web3.Keypair.generate();
  let user1TokenAccount: anchor.web3.PublicKey;
  let user2TokenAccount: anchor.web3.PublicKey;
  let marketTokenAccount: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to users
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(authority.publicKey, 2000000000),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user1.publicKey, 2000000000),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user2.publicKey, 2000000000),
      "confirmed"
    );

    // Create mint
    mint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6 // 6 decimal places
    );

    // Create token accounts
    user1TokenAccount = await createAccount(
      provider.connection,
      user1,
      mint,
      user1.publicKey
    );

    user2TokenAccount = await createAccount(
      provider.connection,
      user2,
      mint,
      user2.publicKey
    );

    // Mint tokens to users
    await mintTo(
      provider.connection,
      authority,
      mint,
      user1TokenAccount,
      authority,
      1000 * 1e6 // 1000 tokens
    );

    await mintTo(
      provider.connection,
      authority,
      mint,
      user2TokenAccount,
      authority,
      1000 * 1e6 // 1000 tokens
    );
  });

  it("Initialize the platform", async () => {
    [globalState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    const tx = await program.methods
      .initialize()
      .accountsPartial({
        globalState,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    console.log("Initialize transaction signature:", tx);

    // Verify global state
    const globalStateAccount = await program.account.globalState.fetch(globalState);
    expect(globalStateAccount.authority.toString()).to.equal(authority.publicKey.toString());
    expect(globalStateAccount.marketCount.toNumber()).to.equal(0);
  });

  it("Create a prediction market", async () => {
    const question = "Will Bitcoin reach $100,000 by end of 2024?";
    const outcomes = ["Yes", "No"];
    const resolutionTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const minBet = 1 * 1e6; // 1 token minimum bet

    const [market] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])], // market_count = 0
      program.programId
    );

    // Create market token account
    marketTokenAccount = await createAccount(
      provider.connection,
      authority,
      mint,
      market,
      authority
    );

    const tx = await program.methods
      .createMarket(question, outcomes, new anchor.BN(resolutionTime), new anchor.BN(minBet))
      .accountsPartial({
        market,
        globalState,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    console.log("Create market transaction signature:", tx);

    // Verify market creation
    const marketAccount = await program.account.market.fetch(market);
    expect(marketAccount.question).to.equal(question);
    expect(marketAccount.outcomes).to.deep.equal(outcomes);
    expect(marketAccount.resolved).to.be.false;
    expect(marketAccount.totalPool.toNumber()).to.equal(0);

    // Verify global state updated
    const globalStateAccount = await program.account.globalState.fetch(globalState);
    expect(globalStateAccount.marketCount.toNumber()).to.equal(1);
  });

  it("Place bets on the market", async () => {
    const [market] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])],
      program.programId
    );

    // User 1 bets on "Yes" (outcome 0)
    const bet1 = anchor.web3.Keypair.generate();
    const betAmount1 = 10 * 1e6; // 10 tokens

    const tx1 = await program.methods
      .placeBet(0, new anchor.BN(betAmount1))
      .accountsPartial({
        bet: bet1.publicKey,
        market,
        bettor: user1.publicKey,
        bettorTokenAccount: user1TokenAccount,
        marketTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1, bet1])
      .rpc();

    console.log("User1 bet transaction signature:", tx1);

    // User 2 bets on "No" (outcome 1)
    const bet2 = anchor.web3.Keypair.generate();
    const betAmount2 = 5 * 1e6; // 5 tokens

    const tx2 = await program.methods
      .placeBet(1, new anchor.BN(betAmount2))
      .accountsPartial({
        bet: bet2.publicKey,
        market,
        bettor: user2.publicKey,
        bettorTokenAccount: user2TokenAccount,
        marketTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user2, bet2])
      .rpc();

    console.log("User2 bet transaction signature:", tx2);

    // Verify bets
    const bet1Account = await program.account.bet.fetch(bet1.publicKey);
    expect(bet1Account.bettor.toString()).to.equal(user1.publicKey.toString());
    expect(bet1Account.outcomeIndex).to.equal(0);
    expect(bet1Account.amount.toNumber()).to.equal(betAmount1);
    expect(bet1Account.claimed).to.be.false;

    const bet2Account = await program.account.bet.fetch(bet2.publicKey);
    expect(bet2Account.bettor.toString()).to.equal(user2.publicKey.toString());
    expect(bet2Account.outcomeIndex).to.equal(1);
    expect(bet2Account.amount.toNumber()).to.equal(betAmount2);
    expect(bet2Account.claimed).to.be.false;

    // Verify market pools updated
    const marketAccount = await program.account.market.fetch(market);
    expect(marketAccount.totalPool.toNumber()).to.equal(betAmount1 + betAmount2);
    expect(marketAccount.outcomePools[0].toNumber()).to.equal(betAmount1);
    expect(marketAccount.outcomePools[1].toNumber()).to.equal(betAmount2);

    // Verify token balances
    const user1Balance = await getAccount(provider.connection, user1TokenAccount);
    expect(Number(user1Balance.amount)).to.equal(990 * 1e6); // 1000 - 10

    const user2Balance = await getAccount(provider.connection, user2TokenAccount);
    expect(Number(user2Balance.amount)).to.equal(995 * 1e6); // 1000 - 5

    const marketBalance = await getAccount(provider.connection, marketTokenAccount);
    expect(Number(marketBalance.amount)).to.equal(15 * 1e6); // 10 + 5
  });

  it("Display market summary", async () => {
    const [market] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])],
      program.programId
    );

    const marketAccount = await program.account.market.fetch(market);
    
    console.log("\n=== MARKET SUMMARY ===");
    console.log("Question:", marketAccount.question);
    console.log("Outcomes:", marketAccount.outcomes);
    console.log("Total Pool:", marketAccount.totalPool.toNumber() / 1e6, "tokens");
    console.log("Outcome Pools:", marketAccount.outcomePools.map(p => p.toNumber() / 1e6));
    console.log("Resolved:", marketAccount.resolved);
    console.log("Winning Outcome:", marketAccount.winningOutcome);
    console.log("Market ID:", marketAccount.marketId.toNumber());
    console.log("========================\n");
  });
});
