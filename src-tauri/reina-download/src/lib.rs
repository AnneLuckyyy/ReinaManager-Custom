//! 当前改版受控下载任务使用的分段续传 HTTP 核心。
//!
//! 本模块由 0.32.0 的独立下载器按当前任务模型移植；它不拥有游戏、
//! 安装、解压或数据库语义，只可靠地把一个已验证的 URL 写入一个目标文件。

mod control;
mod engine;
mod error;
mod fsx;
mod http;
mod limiter;
mod progress;
mod types;

pub use control::{CONTROL_SUFFIX, artifact_paths, control_path};
pub use engine::{adopt_legacy_prefix, download};
pub use error::DownloadError;
pub use progress::{Phase, Progress};
pub use tokio_util::sync::CancellationToken;
pub use types::{DEFAULT_PIECE_SIZE, DownloadOptions, DownloadRequest, Outcome, SharedBudget};
