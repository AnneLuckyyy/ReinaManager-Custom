use std::collections::VecDeque;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use reqwest::header::{ETAG, LAST_MODIFIED, RANGE};
use reqwest::{Client, StatusCode};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::control::{ControlFile, control_path, piece_len};
use crate::error::{DownloadError, map_reqwest};
use crate::fsx;
use crate::http;
use crate::limiter::{Adaptive, Gate};
use crate::progress::{Phase, Progress, Shared};
use crate::types::{DownloadOptions, DownloadRequest, Outcome};

const BASE_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// 将当前改版旧的“从起点连续写入”临时文件安全地接入分片控制文件。
/// 调用方必须先完成其来源版本与大小复查；长度不相等时绝不猜测或改写文件。
pub fn adopt_legacy_prefix(
    target: &Path,
    expected_size: u64,
    prefix_size: u64,
    identity: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<bool, DownloadError> {
    let control_path = control_path(target);
    if control_path.exists() || prefix_size == 0 {
        return Ok(false);
    }
    let metadata = std::fs::metadata(target).map_err(DownloadError::Disk)?;
    if metadata.len() != prefix_size || prefix_size > expected_size {
        return Err(DownloadError::TargetConflict(target.to_path_buf()));
    }
    let mut control = ControlFile::new(
        expected_size,
        crate::DEFAULT_PIECE_SIZE,
        identity,
        etag,
        last_modified,
    );
    let mut remaining = prefix_size;
    for (index, piece) in control.pieces.iter_mut().enumerate() {
        let length = piece_len(expected_size, control.piece_size, index as u64);
        let written = remaining.min(length);
        *piece = written;
        remaining -= written;
        if remaining == 0 {
            break;
        }
    }
    control.save(&control_path).map_err(DownloadError::Disk)?;
    Ok(true)
}

pub async fn download(
    request: DownloadRequest,
    options: DownloadOptions,
    client: Client,
    progress: watch::Sender<Progress>,
    cancel: CancellationToken,
) -> Result<Outcome, DownloadError> {
    options.validate()?;
    let control_file_path = control_path(&request.target);
    let control_exists = control_file_path.exists();
    let existing = match ControlFile::load(&control_file_path) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("discarding unreadable download control file: {error}");
            None
        }
    };
    if !control_exists {
        if let Ok(metadata) = std::fs::metadata(&request.target) {
            if metadata.len() == request.expected_size {
                return Ok(Outcome::Completed);
            }
            return Err(DownloadError::TargetConflict(request.target));
        }
    }
    let shared = Arc::new(Shared::new());
    shared.set_total(request.expected_size);
    let emitter = spawn_emitter(
        Arc::clone(&shared),
        progress.clone(),
        options.progress_interval,
    );
    let result = run(
        &request,
        &options,
        &client,
        Arc::clone(&shared),
        existing,
        &control_file_path,
        &cancel,
    )
    .await;
    shared.set_phase(match result {
        Ok(Outcome::Completed) => Phase::Done,
        Ok(Outcome::Cancelled) => Phase::Cancelled,
        Err(_) => Phase::Downloading,
    });
    emitter.abort();
    let _ = progress.send(shared.snapshot(0.0));
    result
}

async fn run(
    request: &DownloadRequest,
    options: &DownloadOptions,
    client: &Client,
    shared: Arc<Shared>,
    existing: Option<ControlFile>,
    control_file_path: &Path,
    cancel: &CancellationToken,
) -> Result<Outcome, DownloadError> {
    if let Some(control) = existing.as_ref() {
        let written = control.written_total();
        shared.written.store(written, Ordering::Relaxed);
        shared.committed.store(written, Ordering::Relaxed);
    }
    let budget = options.budget.as_ref().map(|value| value.0.clone());
    shared.set_phase(Phase::Probing);
    let probe = tokio::select! { biased; () = cancel.cancelled() => return Ok(Outcome::Cancelled), value = probe_with_retry(client, &request.url, options, &shared, budget.as_ref(), cancel) => value? };
    let probe = if probe.range_supported {
        probe
    } else {
        tokio::select! { biased; () = cancel.cancelled() => return Ok(Outcome::Cancelled), () = tokio::time::sleep(options.range_confirm_delay) => {} }
        match probe_once(client, &request.url, budget.as_ref(), cancel).await {
            Ok(second)
                if second.range_supported
                    && (probe.total.is_none() || probe.total == second.total) =>
            {
                second
            }
            _ => probe,
        }
    };
    if let Some(total) = probe.total {
        if total != request.expected_size {
            return Err(DownloadError::SizeMismatch {
                expected: request.expected_size,
                actual: total,
            });
        }
    }
    let size = request.expected_size;
    let mut control = reconcile(existing, request, &probe, options.piece_size, size);
    if !probe.range_supported {
        control.pieces.fill(0);
    }
    let existing_len = std::fs::metadata(&request.target)
        .ok()
        .map(|value| value.len());
    let claimed = control.written_total();
    // 常规控制文件要求预分配后完整长度；桥接旧文件允许“精确前缀”长度，
    // 控制文件的连续分片计数仍会在下一行被完整验证。
    let usable = existing_len == Some(size)
        || (existing_len == Some(claimed) && claimed > 0 && prefix_is_contiguous(&control));
    if !usable {
        control.pieces.fill(0);
    }
    control
        .save(control_file_path)
        .map_err(DownloadError::Disk)?;
    let path = request.target.clone();
    let file = tokio::task::spawn_blocking(move || fsx::open_target(&path, size))
        .await
        .map_err(join_error)??;
    let file = Arc::new(file);
    let pieces: Arc<Vec<AtomicU64>> = Arc::new(
        control
            .pieces
            .iter()
            .map(|value| AtomicU64::new(*value))
            .collect(),
    );
    let already = control.written_total();
    shared.written.store(already, Ordering::Relaxed);
    shared.committed.store(already, Ordering::Relaxed);
    shared.mark_initialized();
    if control.is_complete() {
        return finish(&shared, &file, control_file_path)
            .await
            .map(|_| Outcome::Completed);
    }
    let committer = Committer {
        file: Arc::clone(&file),
        pieces: Arc::clone(&pieces),
        template: control,
        path: control_file_path.to_path_buf(),
        shared: Arc::clone(&shared),
    };
    let shutdown = CancellationToken::new();
    let committer_task =
        spawn_committer(committer.clone(), options.commit_interval, shutdown.clone());
    let result = if probe.range_supported {
        shared.set_phase(Phase::Downloading);
        run_segmented(
            request,
            options,
            client,
            &shared,
            &pieces,
            &file,
            size,
            cancel,
            budget.as_ref(),
        )
        .await
    } else {
        shared.set_phase(Phase::SingleStream);
        match run_single_stream(
            request,
            options,
            client,
            &shared,
            &pieces,
            &file,
            size,
            cancel,
            budget.as_ref(),
        )
        .await
        {
            Ok(StreamEnd::Upgraded) => {
                shared.set_phase(Phase::Downloading);
                run_segmented(
                    request,
                    options,
                    client,
                    &shared,
                    &pieces,
                    &file,
                    size,
                    cancel,
                    budget.as_ref(),
                )
                .await
            }
            Ok(StreamEnd::Completed) => Ok(Outcome::Completed),
            Ok(StreamEnd::Cancelled) => Ok(Outcome::Cancelled),
            Err(error) => Err(error),
        }
    };
    shutdown.cancel();
    let _ = committer_task.await;
    match result {
        Ok(Outcome::Completed) => {
            committer.commit().await?;
            finish(&shared, &file, control_file_path).await?;
            Ok(Outcome::Completed)
        }
        Ok(Outcome::Cancelled) => {
            committer.commit().await?;
            Ok(Outcome::Cancelled)
        }
        Err(error) => {
            let _ = committer.commit().await;
            Err(error)
        }
    }
}

fn prefix_is_contiguous(control: &ControlFile) -> bool {
    let mut saw_partial = false;
    for (index, value) in control.pieces.iter().enumerate() {
        let length = piece_len(control.size, control.piece_size, index as u64);
        if saw_partial && *value != 0 {
            return false;
        }
        if *value < length {
            saw_partial = true;
        }
    }
    true
}

#[derive(Clone)]
struct Probe {
    total: Option<u64>,
    range_supported: bool,
    etag: Option<String>,
    last_modified: Option<String>,
}

async fn probe_with_retry(
    client: &Client,
    url: &str,
    options: &DownloadOptions,
    shared: &Arc<Shared>,
    budget: Option<&Gate>,
    cancel: &CancellationToken,
) -> Result<Probe, DownloadError> {
    let mut attempt = 0;
    loop {
        match probe_once(client, url, budget, cancel).await {
            Ok(value) => return Ok(value),
            Err(error) if error.is_retryable() && attempt < 4 => {
                attempt += 1;
                shared.retries.fetch_add(1, Ordering::Relaxed);
                tokio::select! { biased; () = cancel.cancelled() => return Ok(Probe { total: None, range_supported: false, etag: None, last_modified: None }), () = tokio::time::sleep(backoff(attempt).min(options.stall_timeout)) => {} }
            }
            Err(error) => return Err(error),
        }
    }
}

async fn probe_once(
    client: &Client,
    url: &str,
    budget: Option<&Gate>,
    cancel: &CancellationToken,
) -> Result<Probe, DownloadError> {
    let _permit = match budget {
        Some(gate) => Some(
            gate.acquire(cancel)
                .await
                .ok_or_else(|| DownloadError::Network("cancelled".into()))?,
        ),
        None => None,
    };
    let response = tokio::select! { biased; () = cancel.cancelled() => return Err(DownloadError::Network("cancelled".into())), response = client.get(url).header(RANGE, "bytes=0-0").send() => response.map_err(|error| map_reqwest(&error))? };
    let status = response.status();
    let headers = response.headers().clone();
    let etag = http::header_string(&headers, ETAG);
    let last_modified = http::header_string(&headers, LAST_MODIFIED);
    match status {
        StatusCode::PARTIAL_CONTENT => {
            http::ensure_identity(&headers)?;
            let range = http::content_range(&headers)?
                .ok_or_else(|| DownloadError::Protocol("206 without Content-Range".into()))?;
            Ok(Probe {
                total: range.total,
                range_supported: true,
                etag,
                last_modified,
            })
        }
        StatusCode::OK => {
            http::ensure_identity(&headers)?;
            Ok(Probe {
                total: http::content_length(&headers)?,
                range_supported: false,
                etag,
                last_modified,
            })
        }
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let value = headers
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| DownloadError::Protocol("416 without Content-Range".into()))?;
            Ok(Probe {
                total: Some(http::parse_unsatisfied_total(value)?),
                range_supported: true,
                etag,
                last_modified,
            })
        }
        _ => Err(http::status_error(status)),
    }
}

fn reconcile(
    existing: Option<ControlFile>,
    request: &DownloadRequest,
    probe: &Probe,
    piece_size: u64,
    size: u64,
) -> ControlFile {
    let fresh = || {
        ControlFile::new(
            size,
            piece_size,
            request.identity.clone(),
            probe.etag.clone(),
            probe.last_modified.clone(),
        )
    };
    let Some(control) = existing else {
        return fresh();
    };
    if control.size != size || control.piece_size != piece_size {
        return fresh();
    }
    if let (Some(ours), Some(theirs)) = (&request.identity, &control.identity) {
        return if ours == theirs { control } else { fresh() };
    }
    let etag_ok = control
        .etag
        .as_deref()
        .zip(probe.etag.as_deref())
        .is_none_or(|(old, new)| old == new);
    let modified_ok = control
        .last_modified
        .as_deref()
        .zip(probe.last_modified.as_deref())
        .is_none_or(|(old, new)| old == new);
    if etag_ok && modified_ok {
        control
    } else {
        fresh()
    }
}

struct WorkerReport {
    index: u64,
    attempt: u32,
    result: Result<(), WorkerFail>,
}
struct WorkerFail {
    error: DownloadError,
    rate_limited: bool,
    retry_after: Option<Duration>,
    started: Instant,
}

async fn run_segmented(
    request: &DownloadRequest,
    options: &DownloadOptions,
    client: &Client,
    shared: &Arc<Shared>,
    pieces: &Arc<Vec<AtomicU64>>,
    file: &Arc<File>,
    size: u64,
    cancel: &CancellationToken,
    budget: Option<&Gate>,
) -> Result<Outcome, DownloadError> {
    let adaptive = Arc::new(Adaptive::new(
        options.min_connections,
        options.clamped_initial(),
        options.max_connections,
        options.grow_after_successes,
    ));
    let mut pending: VecDeque<(u64, u32)> = (0..pieces.len() as u64)
        .filter(|index| {
            pieces[*index as usize].load(Ordering::Relaxed)
                < piece_len(size, options.piece_size, *index)
        })
        .map(|index| (index, 0))
        .collect();
    let mut jobs = JoinSet::new();
    let mut failures = 0;
    loop {
        if cancel.is_cancelled() {
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
            return Ok(Outcome::Cancelled);
        }
        while jobs.len() < adaptive.current() {
            let Some((index, attempt)) = pending.pop_front() else {
                break;
            };
            jobs.spawn(piece_worker(
                client.clone(),
                request.url.clone(),
                Arc::clone(file),
                Arc::clone(pieces),
                Arc::clone(shared),
                Arc::clone(&adaptive),
                budget.cloned(),
                cancel.clone(),
                options.piece_size,
                size,
                index,
                attempt,
                options.stall_timeout,
            ));
        }
        shared.connections.store(jobs.len(), Ordering::Relaxed);
        if jobs.is_empty() {
            return if pending.is_empty() {
                Ok(Outcome::Completed)
            } else {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            };
        }
        let Some(joined) = jobs.join_next().await else {
            continue;
        };
        let report = joined.map_err(join_error)?;
        match report.result {
            Ok(()) => {
                adaptive.on_success();
                failures = 0;
            }
            Err(fail) if fail.error.is_retryable() => {
                shared.retries.fetch_add(1, Ordering::Relaxed);
                failures += 1;
                if failures > options.max_consecutive_failures {
                    jobs.abort_all();
                    return Err(DownloadError::RetriesExhausted {
                        attempts: failures,
                        last: Box::new(fail.error),
                    });
                }
                if fail.rate_limited {
                    adaptive
                        .on_rate_limited(fail.started, fail.retry_after.unwrap_or(BASE_BACKOFF));
                }
                pending.push_back((report.index, report.attempt + 1));
            }
            Err(fail) => {
                jobs.abort_all();
                return Err(fail.error);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn piece_worker(
    client: Client,
    url: String,
    file: Arc<File>,
    pieces: Arc<Vec<AtomicU64>>,
    shared: Arc<Shared>,
    adaptive: Arc<Adaptive>,
    budget: Option<Gate>,
    cancel: CancellationToken,
    piece_size: u64,
    size: u64,
    index: u64,
    attempt: u32,
    stall_timeout: Duration,
) -> WorkerReport {
    let started = Instant::now();
    let delay = backoff(attempt).max(adaptive.remaining_pause());
    if !delay.is_zero() {
        tokio::select! { biased; () = cancel.cancelled() => return WorkerReport { index, attempt, result: Err(WorkerFail { error: DownloadError::Network("cancelled".into()), rate_limited: false, retry_after: None, started }) }, () = tokio::time::sleep(delay) => {} }
    }
    let _permit = match budget {
        Some(gate) => match gate.acquire(&cancel).await {
            Some(value) => Some(value),
            None => {
                return WorkerReport {
                    index,
                    attempt,
                    result: Err(WorkerFail {
                        error: DownloadError::Network("cancelled".into()),
                        rate_limited: false,
                        retry_after: None,
                        started,
                    }),
                };
            }
        },
        None => None,
    };
    let result = fetch_piece(
        &client,
        &url,
        &file,
        &pieces,
        &shared,
        &cancel,
        piece_size,
        size,
        index,
        stall_timeout,
    )
    .await;
    let retry_after = result.as_ref().err().and_then(DownloadError::retry_after);
    let rate_limited = matches!(result, Err(DownloadError::Http { status: 429, .. }));
    WorkerReport {
        index,
        attempt,
        result: result.map_err(|error| WorkerFail {
            retry_after,
            error,
            rate_limited,
            started,
        }),
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_piece(
    client: &Client,
    url: &str,
    file: &Arc<File>,
    pieces: &Arc<Vec<AtomicU64>>,
    shared: &Arc<Shared>,
    cancel: &CancellationToken,
    piece_size: u64,
    size: u64,
    index: u64,
    stall: Duration,
) -> Result<(), DownloadError> {
    let start = index * piece_size;
    let length = piece_len(size, piece_size, index);
    let slot = &pieces[index as usize];
    let mut written = slot.load(Ordering::Relaxed);
    if written >= length {
        return Ok(());
    }
    let range_start = start + written;
    let range_end = start + length - 1;
    let response = tokio::select! { biased; () = cancel.cancelled() => return Err(DownloadError::Network("cancelled".into())), value = client.get(url).header(RANGE, format!("bytes={range_start}-{range_end}")).send() => value.map_err(|error| map_reqwest(&error))? };
    if response.status() != StatusCode::PARTIAL_CONTENT {
        let retry_after = http::retry_after(response.headers(), SystemTime::now());
        return Err(if response.status() == StatusCode::OK {
            DownloadError::Protocol("server stopped honoring range requests".into())
        } else {
            http::status_error(response.status()).with_retry_after(retry_after)
        });
    }
    http::ensure_identity(response.headers())?;
    let range = http::content_range(response.headers())?
        .ok_or_else(|| DownloadError::Protocol("206 without Content-Range".into()))?;
    if range.start != range_start || range.end != range_end {
        return Err(DownloadError::Protocol(
            "Content-Range did not match requested piece".into(),
        ));
    }
    if let Some(length_header) = http::content_length(response.headers())? {
        if length_header != length - written {
            return Err(DownloadError::Protocol(
                "Content-Length did not match requested piece".into(),
            ));
        }
    }
    let mut response = response;
    loop {
        let chunk = tokio::select! { biased; () = cancel.cancelled() => return Err(DownloadError::Network("cancelled".into())), value = tokio::time::timeout(stall, response.chunk()) => value.map_err(|_| DownloadError::Network("download connection stalled".into()))?.map_err(|error| map_reqwest(&error))? };
        let Some(chunk) = chunk else { break };
        if chunk.is_empty() {
            continue;
        }
        let count = chunk.len() as u64;
        if written + count > length {
            return Err(DownloadError::Protocol(
                "piece body exceeded its range".into(),
            ));
        }
        let offset = start + written;
        let file = Arc::clone(file);
        tokio::task::spawn_blocking(move || fsx::write_all_at(&file, offset, &chunk))
            .await
            .map_err(join_error)??;
        written += count;
        slot.store(written, Ordering::Relaxed);
        shared.written.fetch_add(count, Ordering::Relaxed);
    }
    if written == length {
        Ok(())
    } else {
        Err(DownloadError::Network(format!(
            "piece {index} ended early: {written} of {length}"
        )))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_single_stream(
    request: &DownloadRequest,
    options: &DownloadOptions,
    client: &Client,
    shared: &Arc<Shared>,
    pieces: &Arc<Vec<AtomicU64>>,
    file: &Arc<File>,
    size: u64,
    cancel: &CancellationToken,
    budget: Option<&Gate>,
) -> Result<StreamEnd, DownloadError> {
    shared.connections.store(1, Ordering::Relaxed);
    // 单流期间保持分片进度；源站恢复 Range 后可无损转回分段续传。
    let upgrade = Arc::new(AtomicBool::new(false));
    let prober = spawn_upgrade_prober(
        client.clone(),
        request.url.clone(),
        options.upgrade_probe_interval,
        cancel.clone(),
        Arc::clone(&upgrade),
        budget.cloned(),
    );
    let result = run_single_stream_inner(
        request, options, client, shared, pieces, file, size, cancel, &upgrade, budget,
    )
    .await;
    prober.abort();
    result
}

enum StreamEnd {
    Completed,
    Cancelled,
    Upgraded,
}

#[allow(clippy::too_many_arguments)]
async fn run_single_stream_inner(
    request: &DownloadRequest,
    options: &DownloadOptions,
    client: &Client,
    shared: &Arc<Shared>,
    pieces: &Arc<Vec<AtomicU64>>,
    file: &Arc<File>,
    size: u64,
    cancel: &CancellationToken,
    upgrade: &Arc<AtomicBool>,
    budget: Option<&Gate>,
) -> Result<StreamEnd, DownloadError> {
    let mut attempt = 0;
    loop {
        if cancel.is_cancelled() {
            return Ok(StreamEnd::Cancelled);
        }
        if upgrade.load(Ordering::Relaxed) {
            return Ok(StreamEnd::Upgraded);
        }
        if attempt > 0 {
            tokio::select! { biased; () = cancel.cancelled() => return Ok(StreamEnd::Cancelled), () = tokio::time::sleep(backoff(attempt)) => {} }
        }
        match stream_once(
            request, options, client, shared, pieces, file, size, cancel, upgrade, budget,
        )
        .await
        {
            Ok(StreamPass::Completed) => return Ok(StreamEnd::Completed),
            Ok(StreamPass::Cancelled) => return Ok(StreamEnd::Cancelled),
            Ok(StreamPass::Upgraded) => return Ok(StreamEnd::Upgraded),
            Err(error) if error.is_retryable() => {
                attempt += 1;
                if attempt > options.max_consecutive_failures {
                    return Err(DownloadError::RetriesExhausted {
                        attempts: attempt,
                        last: Box::new(error),
                    });
                }
                if upgrade.load(Ordering::Relaxed) {
                    return Ok(StreamEnd::Upgraded);
                }
                reset_pieces(pieces, shared);
            }
            Err(error) => return Err(error),
        }
    }
}

enum StreamPass {
    Completed,
    Cancelled,
    Upgraded,
}

#[allow(clippy::too_many_arguments)]
async fn stream_once(
    request: &DownloadRequest,
    options: &DownloadOptions,
    client: &Client,
    shared: &Arc<Shared>,
    pieces: &Arc<Vec<AtomicU64>>,
    file: &Arc<File>,
    size: u64,
    cancel: &CancellationToken,
    upgrade: &Arc<AtomicBool>,
    budget: Option<&Gate>,
) -> Result<StreamPass, DownloadError> {
    let _permit = match budget {
        Some(gate) => match gate.acquire(cancel).await {
            Some(value) => Some(value),
            None => return Ok(StreamPass::Cancelled),
        },
        None => None,
    };
    let response = tokio::select! { biased; () = cancel.cancelled() => return Ok(StreamPass::Cancelled), value = client.get(&request.url).send() => value.map_err(|error| map_reqwest(&error))? };
    if response.status() != StatusCode::OK {
        return Err(http::status_error(response.status()));
    }
    http::ensure_identity(response.headers())?;
    if let Some(length) = http::content_length(response.headers())? {
        if length != size {
            return Err(DownloadError::SizeMismatch {
                expected: size,
                actual: length,
            });
        }
    }
    let mut response = response;
    let mut absolute = 0;
    loop {
        let chunk = tokio::select! { biased; () = cancel.cancelled() => return Ok(StreamPass::Cancelled), value = tokio::time::timeout(options.stall_timeout, response.chunk()) => value.map_err(|_| DownloadError::Network("single stream stalled".into()))?.map_err(|error| map_reqwest(&error))? };
        let Some(chunk) = chunk else { break };
        if chunk.is_empty() {
            continue;
        }
        let count = chunk.len() as u64;
        if absolute + count > size {
            return Err(DownloadError::Protocol(
                "body exceeded expected size".into(),
            ));
        }
        let offset = absolute;
        let file = Arc::clone(file);
        tokio::task::spawn_blocking(move || fsx::write_all_at(&file, offset, &chunk))
            .await
            .map_err(join_error)??;
        absolute += count;
        shared.written.store(absolute, Ordering::Relaxed);
        set_contiguous_pieces(pieces, size, options.piece_size, absolute);
        if upgrade.load(Ordering::Relaxed) {
            return Ok(StreamPass::Upgraded);
        }
    }
    if absolute != size {
        return Err(DownloadError::Network(format!(
            "single stream ended early: {absolute} of {size}"
        )));
    }
    Ok(StreamPass::Completed)
}

fn spawn_upgrade_prober(
    client: Client,
    url: String,
    interval: Duration,
    cancel: CancellationToken,
    upgrade: Arc<AtomicBool>,
    budget: Option<Gate>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let interval = interval.max(Duration::from_millis(100));
        let mut delay = interval.min(Duration::from_secs(2));
        loop {
            tokio::select! { biased; () = cancel.cancelled() => break, () = tokio::time::sleep(delay) => {} }
            delay = interval;
            if let Ok(probe) = probe_once(&client, &url, budget.as_ref(), &cancel).await
                && probe.range_supported
            {
                upgrade.store(true, Ordering::Relaxed);
                break;
            }
        }
    })
}

fn set_contiguous_pieces(
    pieces: &Arc<Vec<AtomicU64>>,
    size: u64,
    piece_size: u64,
    mut remaining: u64,
) {
    for (index, piece) in pieces.iter().enumerate() {
        let amount = remaining.min(piece_len(size, piece_size, index as u64));
        piece.store(amount, Ordering::Relaxed);
        remaining -= amount;
        if remaining == 0 {
            break;
        }
    }
}
fn reset_pieces(pieces: &Arc<Vec<AtomicU64>>, shared: &Arc<Shared>) {
    for piece in pieces.iter() {
        piece.store(0, Ordering::Relaxed);
    }
    shared.written.store(0, Ordering::Relaxed);
}

#[derive(Clone)]
struct Committer {
    file: Arc<File>,
    pieces: Arc<Vec<AtomicU64>>,
    template: ControlFile,
    path: std::path::PathBuf,
    shared: Arc<Shared>,
}
impl Committer {
    async fn commit(&self) -> Result<(), DownloadError> {
        let snapshot: Vec<u64> = self
            .pieces
            .iter()
            .map(|value| value.load(Ordering::Relaxed))
            .collect();
        let total: u64 = snapshot.iter().sum();
        let mut control = self.template.clone();
        control.pieces = snapshot;
        let file = Arc::clone(&self.file);
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            file.sync_data()?;
            control.save(&path)
        })
        .await
        .map_err(join_error)??;
        self.shared.committed.store(total, Ordering::Relaxed);
        Ok(())
    }
}
fn spawn_committer(
    committer: Committer,
    interval: Duration,
    shutdown: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval.max(Duration::from_millis(100)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            tokio::select! { biased; () = shutdown.cancelled() => break, _ = ticker.tick() => {} }
            if let Err(error) = committer.commit().await {
                log::warn!("periodic download checkpoint failed: {error}");
            }
        }
    })
}
async fn finish(
    shared: &Arc<Shared>,
    file: &Arc<File>,
    control_path: &Path,
) -> Result<(), DownloadError> {
    shared.set_phase(Phase::Finalizing);
    let file = Arc::clone(file);
    tokio::task::spawn_blocking(move || file.sync_all())
        .await
        .map_err(join_error)??;
    fsx::remove_if_exists(control_path).map_err(DownloadError::Disk)
}
fn spawn_emitter(
    shared: Arc<Shared>,
    sender: watch::Sender<Progress>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval.max(Duration::from_millis(50)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut previous = shared.written.load(Ordering::Relaxed);
        let mut at = Instant::now();
        let mut smoothed = 0.0;
        loop {
            ticker.tick().await;
            let written = shared.written.load(Ordering::Relaxed);
            let now = Instant::now();
            let elapsed = now.saturating_duration_since(at).as_secs_f64();
            if elapsed > 0.0 {
                let instant = written.saturating_sub(previous) as f64 / elapsed;
                smoothed = if smoothed == 0.0 {
                    instant
                } else {
                    0.3 * instant + 0.7 * smoothed
                };
            }
            previous = written;
            at = now;
            let _ = sender.send(shared.snapshot(smoothed));
        }
    })
}
fn backoff(attempt: u32) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    let exponent = attempt.saturating_sub(1).min(6);
    let base = BASE_BACKOFF.saturating_mul(1 << exponent).min(MAX_BACKOFF);
    let jitter = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|value| value.subsec_nanos() as u64 % 250)
        .unwrap_or(0);
    base + Duration::from_millis(jitter)
}
fn join_error(error: tokio::task::JoinError) -> DownloadError {
    DownloadError::Disk(std::io::Error::other(format!(
        "worker task failed: {error}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_prefix_is_adopted_only_when_file_length_matches() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("legacy.download");
        std::fs::write(&target, b"prefix").unwrap();

        assert!(
            adopt_legacy_prefix(
                &target,
                32,
                6,
                Some("sha256:known".into()),
                Some("etag".into()),
                None,
            )
            .unwrap()
        );
        let control = ControlFile::load(&control_path(&target)).unwrap().unwrap();
        assert_eq!(control.written_total(), 6);
        assert!(prefix_is_contiguous(&control));
        assert!(!adopt_legacy_prefix(&target, 32, 6, None, None, None).unwrap());

        let wrong = dir.path().join("wrong.download");
        std::fs::write(&wrong, b"prefix").unwrap();
        assert!(adopt_legacy_prefix(&wrong, 32, 5, None, None, None).is_err());
        assert!(!control_path(&wrong).exists());
    }
}
