use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::time::Duration;

use crate::error::DownloadError;
use crate::limiter::Gate;

pub const DEFAULT_PIECE_SIZE: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub url: String,
    pub target: PathBuf,
    pub expected_size: u64,
    pub identity: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SharedBudget(pub(crate) Gate);

impl SharedBudget {
    #[must_use]
    pub fn new(max: usize) -> Self {
        Self(Gate::new(max))
    }
}

#[derive(Debug, Clone)]
pub struct DownloadOptions {
    pub piece_size: u64,
    pub min_connections: usize,
    pub initial_connections: usize,
    pub max_connections: usize,
    pub stall_timeout: Duration,
    pub commit_interval: Duration,
    pub progress_interval: Duration,
    pub grow_after_successes: u32,
    pub max_consecutive_failures: u32,
    pub range_confirm_delay: Duration,
    pub upgrade_probe_interval: Duration,
    pub budget: Option<SharedBudget>,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            piece_size: DEFAULT_PIECE_SIZE,
            min_connections: 1,
            initial_connections: 4,
            max_connections: 8,
            stall_timeout: Duration::from_secs(20),
            commit_interval: Duration::from_secs(2),
            progress_interval: Duration::from_millis(250),
            grow_after_successes: 8,
            max_consecutive_failures: 20,
            range_confirm_delay: Duration::from_millis(1500),
            upgrade_probe_interval: Duration::from_secs(10),
            budget: None,
        }
    }
}

impl DownloadOptions {
    #[must_use]
    pub fn connections(&self) -> RangeInclusive<usize> {
        self.min_connections..=self.max_connections
    }

    pub(crate) fn validate(&self) -> Result<(), DownloadError> {
        if self.piece_size == 0 {
            return Err(DownloadError::InvalidConfig(
                "piece_size must be positive".into(),
            ));
        }
        if self.min_connections == 0 {
            return Err(DownloadError::InvalidConfig(
                "min_connections must be >= 1".into(),
            ));
        }
        if self.max_connections < self.min_connections {
            return Err(DownloadError::InvalidConfig(
                "max_connections must be >= min_connections".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn clamped_initial(&self) -> usize {
        self.initial_connections
            .clamp(self.min_connections, self.max_connections)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Cancelled,
}
