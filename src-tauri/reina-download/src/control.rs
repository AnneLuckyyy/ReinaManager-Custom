use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsx::atomic_write;

pub const CONTROL_SUFFIX: &str = ".reina-dl";
const CONTROL_VERSION: u32 = 1;

#[must_use]
pub fn control_path(target: &Path) -> PathBuf {
    let mut value: OsString = target.as_os_str().to_owned();
    value.push(CONTROL_SUFFIX);
    PathBuf::from(value)
}

#[must_use]
pub fn artifact_paths(target: &Path) -> Vec<PathBuf> {
    let control = control_path(target);
    let mut temp: OsString = control.as_os_str().to_owned();
    temp.push(".tmp");
    vec![target.to_path_buf(), control, PathBuf::from(temp)]
}

#[must_use]
pub(crate) fn piece_count(size: u64, piece_size: u64) -> u64 {
    if size == 0 {
        0
    } else {
        size.div_ceil(piece_size)
    }
}

#[must_use]
pub(crate) fn piece_len(size: u64, piece_size: u64, index: u64) -> u64 {
    let start = index * piece_size;
    (size - start).min(piece_size)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ControlFile {
    pub version: u32,
    pub size: u64,
    pub piece_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    pub pieces: Vec<u64>,
}

impl ControlFile {
    pub(crate) fn new(
        size: u64,
        piece_size: u64,
        identity: Option<String>,
        etag: Option<String>,
        last_modified: Option<String>,
    ) -> Self {
        let count = piece_count(size, piece_size);
        Self {
            version: CONTROL_VERSION,
            size,
            piece_size,
            identity,
            etag,
            last_modified,
            pieces: vec![0; usize::try_from(count).unwrap_or(usize::MAX)],
        }
    }

    pub(crate) fn load(path: &Path) -> io::Result<Option<Self>> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let parsed: Self = serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        parsed
            .validate()
            .map_err(|detail| io::Error::new(io::ErrorKind::InvalidData, detail))?;
        Ok(Some(parsed))
    }

    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        let bytes =
            serde_json::to_vec(self).map_err(|error| io::Error::other(error.to_string()))?;
        atomic_write(path, &bytes)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != CONTROL_VERSION {
            return Err(format!("unsupported control file version {}", self.version));
        }
        if self.piece_size == 0 {
            return Err("piece size must be positive".to_owned());
        }
        let expected = piece_count(self.size, self.piece_size);
        if u64::try_from(self.pieces.len()).ok() != Some(expected) {
            return Err(format!(
                "piece count mismatch: expected {expected}, found {}",
                self.pieces.len()
            ));
        }
        for (index, written) in self.pieces.iter().enumerate() {
            if *written > piece_len(self.size, self.piece_size, index as u64) {
                return Err(format!("piece {index} claims too many bytes"));
            }
        }
        Ok(())
    }

    #[must_use]
    pub(crate) fn written_total(&self) -> u64 {
        self.pieces.iter().sum()
    }

    #[must_use]
    pub(crate) fn is_complete(&self) -> bool {
        self.pieces
            .iter()
            .enumerate()
            .all(|(index, written)| *written == piece_len(self.size, self.piece_size, index as u64))
    }
}
