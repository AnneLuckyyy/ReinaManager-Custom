use std::time::{Duration, SystemTime};

use reqwest::StatusCode;
use reqwest::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, HeaderMap, RETRY_AFTER};

use crate::error::DownloadError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContentRange {
    pub start: u64,
    pub end: u64,
    pub total: Option<u64>,
}

pub(crate) fn parse_content_range(value: &str) -> Result<ContentRange, DownloadError> {
    let value = value.trim();
    let rest = value
        .strip_prefix("bytes ")
        .or_else(|| value.strip_prefix("bytes="))
        .ok_or_else(|| {
            DownloadError::Protocol(format!("Content-Range is not in bytes: {value}"))
        })?;
    let (range, total) = rest
        .split_once('/')
        .ok_or_else(|| DownloadError::Protocol(format!("malformed Content-Range: {value}")))?;
    if range.trim() == "*" {
        return Err(DownloadError::Protocol(format!(
            "unsatisfied Content-Range where a byte range was expected: {value}"
        )));
    }
    let total = match total.trim() {
        "*" => None,
        digits => Some(digits.parse::<u64>().map_err(|error| {
            DownloadError::Protocol(format!("invalid Content-Range total: {error}"))
        })?),
    };
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| DownloadError::Protocol(format!("malformed Content-Range: {value}")))?;
    let start = start.trim().parse::<u64>().map_err(|error| {
        DownloadError::Protocol(format!("invalid Content-Range start: {error}"))
    })?;
    let end = end
        .trim()
        .parse::<u64>()
        .map_err(|error| DownloadError::Protocol(format!("invalid Content-Range end: {error}")))?;
    if start > end || total.is_some_and(|total| end >= total) {
        return Err(DownloadError::Protocol(format!(
            "invalid Content-Range bounds: {value}"
        )));
    }
    Ok(ContentRange { start, end, total })
}
pub(crate) fn parse_unsatisfied_total(value: &str) -> Result<u64, DownloadError> {
    let rest = value.trim().strip_prefix("bytes ").ok_or_else(|| {
        DownloadError::Protocol(format!("Content-Range is not in bytes: {value}"))
    })?;
    let total = rest.strip_prefix("*/").ok_or_else(|| {
        DownloadError::Protocol(format!("expected unsatisfied Content-Range, got: {value}"))
    })?;
    total
        .trim()
        .parse::<u64>()
        .map_err(|error| DownloadError::Protocol(format!("invalid Content-Range total: {error}")))
}
pub(crate) fn content_range(headers: &HeaderMap) -> Result<Option<ContentRange>, DownloadError> {
    let Some(value) = headers.get(CONTENT_RANGE) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|error| {
        DownloadError::Protocol(format!("invalid Content-Range header: {error}"))
    })?;
    parse_content_range(value).map(Some)
}
pub(crate) fn content_length(headers: &HeaderMap) -> Result<Option<u64>, DownloadError> {
    let Some(value) = headers.get(CONTENT_LENGTH) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|error| {
        DownloadError::Protocol(format!("invalid Content-Length header: {error}"))
    })?;
    value
        .trim()
        .parse::<u64>()
        .map(Some)
        .map_err(|error| DownloadError::Protocol(format!("invalid Content-Length: {error}")))
}
pub(crate) fn ensure_identity(headers: &HeaderMap) -> Result<(), DownloadError> {
    if let Some(value) = headers.get(CONTENT_ENCODING) {
        let value = value.to_str().map_err(|error| {
            DownloadError::Protocol(format!("invalid Content-Encoding: {error}"))
        })?;
        if !value.trim().eq_ignore_ascii_case("identity") {
            return Err(DownloadError::Protocol(format!(
                "unexpected Content-Encoding {value}; byte ranges require identity"
            )));
        }
    }
    Ok(())
}
pub(crate) fn header_string(
    headers: &HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
#[must_use]
pub(crate) fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_EARLY
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}
pub(crate) fn status_error(status: StatusCode) -> DownloadError {
    DownloadError::Http {
        status: status.as_u16(),
        retryable: is_retryable_status(status),
        retry_after: None,
    }
}

pub(crate) fn retry_after(headers: &HeaderMap, now: SystemTime) -> Option<Duration> {
    const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    let delay = if let Ok(seconds) = value.parse::<u64>() {
        Duration::from_secs(seconds)
    } else {
        httpdate::parse_http_date(value)
            .ok()?
            .duration_since(now)
            .unwrap_or(Duration::ZERO)
    };
    Some(delay.min(MAX_RETRY_AFTER))
}
