use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("EHgavRW857rfGMyP17kjKcuSqj8Gh9fVKC6A2HcBkeF5");

#[program]
pub mod betting_markets {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        global_state.authority = ctx.accounts.authority.key();
        global_state.market_count = 0;
        msg!("Betting Markets platform initialized!");
        Ok(())
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        outcomes: Vec<String>,
        resolution_time: i64,
        min_bet: u64,
    ) -> Result<()> {
        require!(outcomes.len() >= 2, ErrorCode::InsufficientOutcomes);
        require!(outcomes.len() <= 10, ErrorCode::TooManyOutcomes);
        require!(resolution_time > Clock::get()?.unix_timestamp, ErrorCode::InvalidResolutionTime);

        let market = &mut ctx.accounts.market;
        let global_state = &mut ctx.accounts.global_state;
        
        market.authority = ctx.accounts.authority.key();
        market.question = question;
        market.outcomes = outcomes.clone();
        market.outcome_pools = vec![0; outcomes.len()];
        market.resolution_time = resolution_time;
        market.min_bet = min_bet;
        market.resolved = false;
        market.winning_outcome = None;
        market.total_pool = 0;
        market.market_id = global_state.market_count;
        market.created_at = Clock::get()?.unix_timestamp;

        global_state.market_count += 1;

        emit!(MarketCreated {
            market_id: market.market_id,
            authority: market.authority,
            question: market.question.clone(),
            outcomes: outcomes,
            resolution_time,
        });

        Ok(())
    }

    pub fn place_bet(
        ctx: Context<PlaceBet>,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        
        require!(!market.resolved, ErrorCode::MarketResolved);
        require!(Clock::get()?.unix_timestamp < market.resolution_time, ErrorCode::BettingClosed);
        require!(amount >= market.min_bet, ErrorCode::BetTooSmall);
        require!((outcome_index as usize) < market.outcomes.len(), ErrorCode::InvalidOutcome);

        let bet = &mut ctx.accounts.bet;
        bet.bettor = ctx.accounts.bettor.key();
        bet.market = ctx.accounts.market.key();
        bet.outcome_index = outcome_index;
        bet.amount = amount;
        bet.claimed = false;
        bet.timestamp = Clock::get()?.unix_timestamp;

        // Transfer tokens from bettor to market pool
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bettor_token_account.to_account_info(),
                    to: ctx.accounts.market_token_account.to_account_info(),
                    authority: ctx.accounts.bettor.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update market pools
        market.outcome_pools[outcome_index as usize] += amount;
        market.total_pool += amount;

        emit!(BetPlaced {
            bettor: bet.bettor,
            market_id: market.market_id,
            outcome_index,
            amount,
        });

        Ok(())
    }

    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        winning_outcome_index: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        
        require!(ctx.accounts.authority.key() == market.authority, ErrorCode::Unauthorized);
        require!(!market.resolved, ErrorCode::MarketAlreadyResolved);
        require!(Clock::get()?.unix_timestamp >= market.resolution_time, ErrorCode::TooEarlyToResolve);
        require!((winning_outcome_index as usize) < market.outcomes.len(), ErrorCode::InvalidOutcome);

        market.resolved = true;
        market.winning_outcome = Some(winning_outcome_index);

        emit!(MarketResolved {
            market_id: market.market_id,
            winning_outcome: winning_outcome_index,
            winning_outcome_name: market.outcomes[winning_outcome_index as usize].clone(),
        });

        Ok(())
    }

    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let market = &ctx.accounts.market;
        let bet = &mut ctx.accounts.bet;
        
        require!(market.resolved, ErrorCode::MarketNotResolved);
        require!(!bet.claimed, ErrorCode::AlreadyClaimed);
        require!(bet.bettor == ctx.accounts.bettor.key(), ErrorCode::Unauthorized);
        
        let winning_outcome = market.winning_outcome.unwrap();
        require!(bet.outcome_index == winning_outcome, ErrorCode::LosingBet);

        // Calculate payout
        let winning_pool = market.outcome_pools[winning_outcome as usize];
        let payout = if winning_pool > 0 {
            (bet.amount as u128 * market.total_pool as u128 / winning_pool as u128) as u64
        } else {
            0
        };

        require!(payout > 0, ErrorCode::NoPayoutAvailable);

        bet.claimed = true;

        // Transfer payout to bettor
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_token_account.to_account_info(),
                    to: ctx.accounts.bettor_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[&[
                    b"market",
                    &market.market_id.to_le_bytes(),
                    &[ctx.bumps.market],
                ]],
            ),
            payout,
        )?;

        emit!(PayoutClaimed {
            bettor: bet.bettor,
            market_id: market.market_id,
            bet_amount: bet.amount,
            payout_amount: payout,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GlobalState::INIT_SPACE,
        seeds = [b"global_state"],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(question: String)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE + question.len() + 200, // Extra space for outcomes
        seeds = [b"market", &global_state.market_count.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(
        init,
        payer = bettor,
        space = 8 + Bet::INIT_SPACE,
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub bettor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub market_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub bet: Account<'info, Bet>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub bettor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub market_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalState {
    pub authority: Pubkey,
    pub market_count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub market_id: u64,
    #[max_len(200)]
    pub question: String,
    #[max_len(10, 50)]
    pub outcomes: Vec<String>,
    #[max_len(10)]
    pub outcome_pools: Vec<u64>,
    pub resolution_time: i64,
    pub min_bet: u64,
    pub resolved: bool,
    pub winning_outcome: Option<u8>,
    pub total_pool: u64,
    pub created_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub bettor: Pubkey,
    pub market: Pubkey,
    pub outcome_index: u8,
    pub amount: u64,
    pub claimed: bool,
    pub timestamp: i64,
}

#[event]
pub struct MarketCreated {
    pub market_id: u64,
    pub authority: Pubkey,
    pub question: String,
    pub outcomes: Vec<String>,
    pub resolution_time: i64,
}

#[event]
pub struct BetPlaced {
    pub bettor: Pubkey,
    pub market_id: u64,
    pub outcome_index: u8,
    pub amount: u64,
}

#[event]
pub struct MarketResolved {
    pub market_id: u64,
    pub winning_outcome: u8,
    pub winning_outcome_name: String,
}

#[event]
pub struct PayoutClaimed {
    pub bettor: Pubkey,
    pub market_id: u64,
    pub bet_amount: u64,
    pub payout_amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Market needs at least 2 outcomes")]
    InsufficientOutcomes,
    #[msg("Market can have at most 10 outcomes")]
    TooManyOutcomes,
    #[msg("Resolution time must be in the future")]
    InvalidResolutionTime,
    #[msg("Market is already resolved")]
    MarketResolved,
    #[msg("Betting period has ended")]
    BettingClosed,
    #[msg("Bet amount is below minimum")]
    BetTooSmall,
    #[msg("Invalid outcome index")]
    InvalidOutcome,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Market is already resolved")]
    MarketAlreadyResolved,
    #[msg("Too early to resolve market")]
    TooEarlyToResolve,
    #[msg("Market is not resolved yet")]
    MarketNotResolved,
    #[msg("Payout already claimed")]
    AlreadyClaimed,
    #[msg("This bet is on a losing outcome")]
    LosingBet,
    #[msg("No payout available")]
    NoPayoutAvailable,
}
