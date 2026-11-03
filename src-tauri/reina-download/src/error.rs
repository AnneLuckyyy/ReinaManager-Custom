use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug)]
pub enum DownloadError {
    Http {
        status: u16,
        retryable: bool,
        retry_after: Option<Duration>,
    },
    SizeMismatch {
        expected: u64,
        actual: u64,
    },
    RemoteChanged(String),
    Protocol(String),
    Network(String),
    Disk(std::io::Error),
    TargetConflict(PathBuf),
    RetriesExhausted {
        attempts: u32,
        last: Box<DownloadError>,
    },
    InvalidConfig(String),
}

impl DownloadError {
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http { retryable, .. } => *retryable,
            Self::Protocol(_) | Self::Network(_) => true,
            Self::SizeMismatch { .. }
            | Self::RemoteChanged(_)
            | Self::Disk(_)
            | Self::TargetConflict(_)
            | Self::RetriesExhausted { .. }
            | Self::InvalidConfig(_) => false,
        }
    }

    #[must_use]
    pub fn http_status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => Some(*status),
            Self::RetriesExhausted { last, .. } => last.http_status(),
            _ => None,
        }
    }

    pub(crate) fn with_retry_after(self, retry_after: Option<Duration>) -> Self {
        match self {
            Self::Http {
                status, retryable, ..
            } => Self::Http {
                status,
                retryable,
                retry_after,
            },
            other => other,
        }
    }

    pub(crate) fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Http { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http {
                status, retryable, ..
            } => {
                if *retryable {
                    write!(f, "retryable HTTP status {status}")
                } else {
                    write!(f, "HTTP status {status}")
                }
            }
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "size mismatch: expected {expected} bytes, server reports {actual}"
            ),
            Self::RemoteChanged(detail) => write!(f, "remote resource changed: {detail}"),
            Self::Protocol(detail) => write!(f, "HTTP protocol violation: {detail}"),
            Self::Network(detail) => write!(f, "network error: {detail}"),
            Self::Disk(error) => write!(f, "disk error: {error}"),
            Self::TargetConflict(path) => write!(
                f,
                "target already exists without a control file: {}",
                path.display()
            ),
            Self::RetriesExhausted { attempts, last } => write!(
                f,
                "gave up after {attempts} consecutive failures; last error: {last}"
            ),
            Self::InvalidConfig(detail) => write!(f, "invalid configuration: {detail}"),
        }
    }
}

impl std::error::Error for DownloadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Disk(error) => Some(error),
            Self::RetriesExhausted { last, .. } => Some(last.as_ref()),
            _ => None,
        }
    }
}

impl From<std::io::Error> for DownloadError {
    fn from(error: std::io::Error) -> Self {
        Self::Disk(error)
    }
}

pub(crate) fn map_reqwest(error: &reqwest::Error) -> DownloadError {
    if error.is_timeout() {
        return DownloadError::Network(format!("request timed out: {error}"));
    }
    if error.is_connect() {
        return DownloadError::Network(format!("connection failed: {error}"));
    }
    if error.is_redirect() {
        return DownloadError::Protocol(format!("redirect policy violated: {error}"));
    }
    if error.is_body() || error.is_decode() {
        return DownloadError::Network(format!("body transfer failed: {error}"));
    }
    if error.is_builder() {
        return DownloadError::InvalidConfig(error.to_string());
    }
    if error.is_request() {
        return DownloadError::Network(format!("request failed: {error}"));
    }
    DownloadError::Network(error.to_string())
}
