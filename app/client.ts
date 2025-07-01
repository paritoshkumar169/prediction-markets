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

// Client class for interacting with the Betting Markets program
export class BettingMarketsClient {
  constructor(
    public program: Program<BettingMarkets>,
    public provider: anchor.AnchorProvider
  ) {}

  async initialize(authority: anchor.web3.Keypair): Promise<string> {
    const [globalState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      this.program.programId
    );

    const tx = await this.program.methods
      .initialize()
      .accountsPartial({
        globalState,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    return tx;
  }

  async createMarket(
    authority: anchor.web3.Keypair,
    question: string,
    outcomes: string[],
    resolutionTime: number,
    minBet: number,
    marketId: number = 0
  ): Promise<{
    transaction: string;
    marketAddress: anchor.web3.PublicKey;
  }> {
    const [globalState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      this.program.programId
    );

    const [market] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(marketId)]).buffer))],
      this.program.programId
    );

    const tx = await this.program.methods
      .createMarket(
        question,
        outcomes,
        new anchor.BN(resolutionTime),
        new anchor.BN(minBet)
      )
      .accountsPartial({
        market,
        globalState,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    return {
      transaction: tx,
      marketAddress: market,
    };
  }

  async placeBet(
    bettor: anchor.web3.Keypair,
    market: anchor.web3.PublicKey,
    outcomeIndex: number,
    amount: number,
    bettorTokenAccount: anchor.web3.PublicKey,
    marketTokenAccount: anchor.web3.PublicKey
  ): Promise<{
    transaction: string;
    betAddress: anchor.web3.PublicKey;
  }> {
    const bet = anchor.web3.Keypair.generate();

    const tx = await this.program.methods
      .placeBet(outcomeIndex, new anchor.BN(amount))
      .accountsPartial({
        bet: bet.publicKey,
        market,
        bettor: bettor.publicKey,
        bettorTokenAccount,
        marketTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([bettor, bet])
      .rpc();

    return {
      transaction: tx,
      betAddress: bet.publicKey,
    };
  }

  async resolveMarket(
    authority: anchor.web3.Keypair,
    market: anchor.web3.PublicKey,
    winningOutcomeIndex: number
  ): Promise<string> {
    const tx = await this.program.methods
      .resolveMarket(winningOutcomeIndex)
      .accountsPartial({
        market,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    return tx;
  }

  async claimPayout(
    bettor: anchor.web3.Keypair,
    bet: anchor.web3.PublicKey,
    market: anchor.web3.PublicKey,
    bettorTokenAccount: anchor.web3.PublicKey,
    marketTokenAccount: anchor.web3.PublicKey
  ): Promise<string> {
    const tx = await this.program.methods
      .claimPayout()
      .accountsPartial({
        bet,
        market,
        bettor: bettor.publicKey,
        bettorTokenAccount,
        marketTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bettor])
      .rpc();

    return tx;
  }

  // Helper methods for fetching data
  async getGlobalState(): Promise<any> {
    const [globalState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      this.program.programId
    );
    return this.program.account.globalState.fetch(globalState);
  }

  async getMarket(marketAddress: anchor.web3.PublicKey): Promise<any> {
    return this.program.account.market.fetch(marketAddress);
  }

  async getBet(betAddress: anchor.web3.PublicKey): Promise<any> {
    return this.program.account.bet.fetch(betAddress);
  }

  async getMarketAddress(marketId: number): Promise<anchor.web3.PublicKey> {
    const [market] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(new Uint8Array(new BigUint64Array([BigInt(marketId)]).buffer))],
      this.program.programId
    );
    return market;
  }
}

// Example usage function
export async function demonstrateUsage() {
  // Setup
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.bettingMarkets as Program<BettingMarkets>;
  const client = new BettingMarketsClient(program, provider);

  // Create test users
  const authority = anchor.web3.Keypair.generate();
  const user1 = anchor.web3.Keypair.generate();
  const user2 = anchor.web3.Keypair.generate();

  // Airdrop SOL
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(authority.publicKey, 2000000000)
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(user1.publicKey, 2000000000)
  );
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(user2.publicKey, 2000000000)
  );

  console.log("=== Polymarket-like Betting Platform Demo ===\n");

  // 1. Initialize the platform
  console.log("1. Initializing the betting platform...");
  const initTx = await client.initialize(authority);
  console.log(`   ✅ Platform initialized: ${initTx}\n`);

  // 2. Create a prediction market
  console.log("2. Creating a prediction market...");
  const question = "Will Bitcoin reach $100,000 by end of 2024?";
  const outcomes = ["Yes", "No"];
  const resolutionTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const minBet = 1000000; // 1 token (6 decimals)

  const { transaction: createTx, marketAddress } = await client.createMarket(
    authority,
    question,
    outcomes,
    resolutionTime,
    minBet
  );
  console.log(`   ✅ Market created: ${createTx}`);
  console.log(`   📊 Market Address: ${marketAddress.toString()}\n`);

  // 3. Display market info
  const marketInfo = await client.getMarket(marketAddress);
  console.log("3. Market Information:");
  console.log(`   Question: ${marketInfo.question}`);
  console.log(`   Outcomes: ${marketInfo.outcomes.join(" vs ")}`);
  console.log(`   Min Bet: ${marketInfo.minBet.toNumber() / 1e6} tokens`);
  console.log(`   Resolution Time: ${new Date(marketInfo.resolutionTime.toNumber() * 1000)}\n`);

  // 4. Show platform statistics
  const globalState = await client.getGlobalState();
  console.log("4. Platform Statistics:");
  console.log(`   Total Markets Created: ${globalState.marketCount.toNumber()}`);
  console.log(`   Platform Authority: ${globalState.authority.toString()}\n`);

  console.log("=== Demo Complete ===");
  console.log("\nTo place bets, resolve markets, and claim payouts:");
  console.log("1. Create token accounts for users");
  console.log("2. Use client.placeBet() for betting");
  console.log("3. Use client.resolveMarket() when the event concludes");
  console.log("4. Use client.claimPayout() for winners to claim rewards");
}


if (require.main === module) {
  demonstrateUsage().catch(console.error);
} 