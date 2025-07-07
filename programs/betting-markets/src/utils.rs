use borsh::{BorshDeserialize, BorshSerialize};
use anchor_lang::prelude::*;

/// Custom serialization for market statistics
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct MarketStats {
    pub total_volume: u64,
    pub unique_bettors: u32,
    pub outcome_probabilities: Vec<f64>,
    pub last_updated: i64,
}

impl MarketStats {
    pub fn new() -> Self {
        Self {
            total_volume: 0,
            unique_bettors: 0,
            outcome_probabilities: vec![],
            last_updated: 0,
        }
    }

    /// Calculate implied probabilities based on betting pools
    pub fn calculate_probabilities(&mut self, outcome_pools: &[u64], total_pool: u64) {
        if total_pool == 0 {
            self.outcome_probabilities = vec![0.0; outcome_pools.len()];
            return;
        }

        self.outcome_probabilities = outcome_pools
            .iter()
            .map(|&pool| pool as f64 / total_pool as f64)
            .collect();
    }

    /// Serialize to bytes for storage
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        self.try_to_vec().map_err(|_| ErrorCode::SerializationError.into())
    }

    /// Deserialize from bytes
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        Self::try_from_slice(data).map_err(|_| ErrorCode::DeserializationError.into())
    }
}

/// Custom data structure for historical market data
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct HistoricalData {
    pub timestamp: i64,
    pub action_type: ActionType,
    pub amount: u64,
    pub outcome_index: u8,
    pub bettor: Pubkey,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum ActionType {
    BetPlaced,
    MarketResolved,
    PayoutClaimed,
}

/// Batch operations for efficient serialization
#[derive(BorshSerialize, BorshDeserialize)]
pub struct BatchOperation {
    pub operations: Vec<HistoricalData>,
    pub batch_id: u64,
    pub created_at: i64,
}

impl BatchOperation {
    pub fn new(batch_id: u64) -> Self {
        Self {
            operations: Vec::new(),
            batch_id,
            created_at: anchor_lang::solana_program::clock::Clock::get()
                .unwrap()
                .unix_timestamp,
        }
    }

    pub fn add_operation(&mut self, operation: HistoricalData) {
        self.operations.push(operation);
    }

    /// Serialize batch to compressed format
    pub fn serialize_compressed(&self) -> Result<Vec<u8>> {
        // Simple compression by removing redundant data
        let mut compressed = Vec::new();
        
        // Add batch metadata
        compressed.extend_from_slice(&self.batch_id.to_le_bytes());
        compressed.extend_from_slice(&self.created_at.to_le_bytes());
        compressed.extend_from_slice(&(self.operations.len() as u32).to_le_bytes());

        // Add operations
        for op in &self.operations {
            let op_bytes = op.try_to_vec().map_err(|_| ErrorCode::SerializationError)?;
            compressed.extend_from_slice(&(op_bytes.len() as u32).to_le_bytes());
            compressed.extend_from_slice(&op_bytes);
        }

        Ok(compressed)
    }
}

/// Custom error codes for serialization
#[error_code]
pub enum SerializationErrorCode {
    #[msg("Failed to serialize data")]
    SerializationError,
    #[msg("Failed to deserialize data")]
    DeserializationError,
    #[msg("Invalid data format")]
    InvalidDataFormat,
}

/// Utility functions for Borsh operations
pub mod borsh_utils {
    use super::*;

    /// Safe serialization with error handling
    pub fn safe_serialize<T: BorshSerialize>(data: &T) -> Result<Vec<u8>> {
        data.try_to_vec()
            .map_err(|_| ErrorCode::SerializationError.into())
    }

    /// Safe deserialization with error handling
    pub fn safe_deserialize<T: BorshDeserialize>(bytes: &[u8]) -> Result<T> {
        T::try_from_slice(bytes)
            .map_err(|_| ErrorCode::DeserializationError.into())
    }

    /// Calculate size of serialized data
    pub fn calculate_size<T: BorshSerialize>(data: &T) -> Result<usize> {
        Ok(data.try_to_vec()?.len())
    }

    /// Validate serialization round-trip
    pub fn validate_roundtrip<T: BorshSerialize + BorshDeserialize + PartialEq>(
        data: &T,
    ) -> Result<bool> {
        let serialized = safe_serialize(data)?;
        let deserialized: T = safe_deserialize(&serialized)?;
        Ok(*data == deserialized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_market_stats_serialization() {
        let mut stats = MarketStats::new();
        stats.total_volume = 1000;
        stats.unique_bettors = 5;
        stats.outcome_probabilities = vec![0.6, 0.4];

        let bytes = stats.to_bytes().unwrap();
        let deserialized = MarketStats::from_bytes(&bytes).unwrap();

        assert_eq!(stats.total_volume, deserialized.total_volume);
        assert_eq!(stats.unique_bettors, deserialized.unique_bettors);
        assert_eq!(stats.outcome_probabilities, deserialized.outcome_probabilities);
    }

    #[test]
    fn test_batch_operation_serialization() {
        let mut batch = BatchOperation::new(1);
        
        let operation = HistoricalData {
            timestamp: 1234567890,
            action_type: ActionType::BetPlaced,
            amount: 1000,
            outcome_index: 0,
            bettor: Pubkey::default(),
        };

        batch.add_operation(operation);
        
        let compressed = batch.serialize_compressed().unwrap();
        assert!(!compressed.is_empty());
    }
} 