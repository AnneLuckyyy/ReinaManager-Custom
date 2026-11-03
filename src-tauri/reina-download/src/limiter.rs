use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub(crate) struct Gate {
    inner: Arc<GateInner>,
}
#[derive(Debug)]
struct GateInner {
    state: Mutex<GateState>,
    notify: Notify,
}
#[derive(Debug)]
struct GateState {
    max: usize,
    in_flight: usize,
}
#[derive(Debug)]
pub(crate) struct GatePermit {
    inner: Arc<GateInner>,
}

impl Gate {
    pub(crate) fn new(max: usize) -> Self {
        Self {
            inner: Arc::new(GateInner {
                state: Mutex::new(GateState {
                    max: max.max(1),
                    in_flight: 0,
                }),
                notify: Notify::new(),
            }),
        }
    }
    pub(crate) async fn acquire(&self, cancel: &CancellationToken) -> Option<GatePermit> {
        loop {
            let notified = {
                let mut state = self.lock();
                if state.in_flight < state.max {
                    state.in_flight += 1;
                    return Some(GatePermit {
                        inner: Arc::clone(&self.inner),
                    });
                }
                self.inner.notify.notified()
            };
            tokio::select! { biased; () = cancel.cancelled() => return None, () = notified => {} }
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}
impl Drop for GatePermit {
    fn drop(&mut self) {
        {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        self.inner.notify.notify_one();
    }
}

#[derive(Debug)]
pub(crate) struct Adaptive {
    min: usize,
    max: usize,
    target: AtomicUsize,
    grow_after: u32,
    successes: AtomicUsize,
    timing: Mutex<Timing>,
}
#[derive(Debug)]
struct Timing {
    last_change: Option<Instant>,
    not_before: Instant,
}
impl Adaptive {
    pub(crate) fn new(min: usize, initial: usize, max: usize, grow_after: u32) -> Self {
        let min = min.max(1);
        let max = max.max(min);
        Self {
            min,
            max,
            target: AtomicUsize::new(initial.clamp(min, max)),
            grow_after,
            successes: AtomicUsize::new(0),
            timing: Mutex::new(Timing {
                last_change: None,
                not_before: Instant::now(),
            }),
        }
    }
    pub(crate) fn current(&self) -> usize {
        self.target.load(Ordering::Relaxed)
    }
    pub(crate) fn remaining_pause(&self) -> Duration {
        self.lock()
            .not_before
            .saturating_duration_since(Instant::now())
    }
    pub(crate) fn on_rate_limited(&self, attempt_started: Instant, delay: Duration) {
        let now = Instant::now();
        let mut timing = self.lock();
        timing.not_before = timing.not_before.max(now + delay);
        if !timing
            .last_change
            .is_some_and(|last| attempt_started <= last)
            && self.current() > self.min
        {
            self.target
                .store(self.current().div_ceil(2).max(self.min), Ordering::Relaxed);
            timing.last_change = Some(now);
        }
        self.successes.store(0, Ordering::Relaxed);
    }
    pub(crate) fn on_success(&self) {
        let streak = self.successes.fetch_add(1, Ordering::Relaxed) + 1;
        if streak >= self.grow_after as usize {
            self.successes.store(0, Ordering::Relaxed);
            let current = self.current();
            if current < self.max {
                self.target.store(current + 1, Ordering::Relaxed);
            }
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Timing> {
        self.timing
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}
