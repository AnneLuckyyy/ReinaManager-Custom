use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    Probing = 0,
    Downloading = 1,
    SingleStream = 2,
    Finalizing = 3,
    Done = 4,
    Cancelled = 5,
}
impl Phase {
    pub(crate) fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Probing,
            1 => Self::Downloading,
            2 => Self::SingleStream,
            3 => Self::Finalizing,
            5 => Self::Cancelled,
            _ => Self::Done,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    pub phase: Phase,
    pub initialized: bool,
    pub total: u64,
    pub committed: u64,
    pub written: u64,
    pub speed_bps: f64,
    pub connections: usize,
    pub retries: u32,
}
impl Progress {
    #[must_use]
    pub fn initial() -> Self {
        Self {
            phase: Phase::Probing,
            initialized: false,
            total: 0,
            committed: 0,
            written: 0,
            speed_bps: 0.0,
            connections: 0,
            retries: 0,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Shared {
    phase: AtomicU8,
    initialized: AtomicBool,
    total: AtomicU64,
    pub written: AtomicU64,
    pub committed: AtomicU64,
    pub connections: AtomicUsize,
    pub retries: AtomicU32,
}
impl Shared {
    pub(crate) fn new() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Probing as u8),
            initialized: AtomicBool::new(false),
            total: AtomicU64::new(0),
            written: AtomicU64::new(0),
            committed: AtomicU64::new(0),
            connections: AtomicUsize::new(0),
            retries: AtomicU32::new(0),
        }
    }
    pub(crate) fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Relaxed);
    }
    pub(crate) fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::Relaxed);
    }
    pub(crate) fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::Release);
    }
    pub(crate) fn snapshot(&self, speed_bps: f64) -> Progress {
        Progress {
            phase: Phase::from_u8(self.phase.load(Ordering::Relaxed)),
            initialized: self.initialized.load(Ordering::Acquire),
            total: self.total.load(Ordering::Relaxed),
            written: self.written.load(Ordering::Relaxed),
            committed: self.committed.load(Ordering::Relaxed),
            speed_bps,
            connections: self.connections.load(Ordering::Relaxed),
            retries: self.retries.load(Ordering::Relaxed),
        }
    }
}
