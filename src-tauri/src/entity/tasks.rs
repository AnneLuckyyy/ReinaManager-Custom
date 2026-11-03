//! 受控游戏下载任务实体。

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "tasks")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub task_kind: String,
    #[sea_orm(column_type = "Text")]
    pub url: String,
    #[sea_orm(column_type = "Text")]
    pub root_path: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub file_name: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub checksum_algorithm: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub checksum_value: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub remote_etag: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub remote_last_modified: Option<String>,
    pub source_expires_at: Option<i64>,
    #[sea_orm(column_type = "Text", nullable)]
    pub install_stage: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub install_root_path: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub source_provider: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub source_resource_id: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub archive_format: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub metadata_json: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub install_result_json: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error_code: Option<String>,
    pub auto_import: bool,
    pub auto_delete: bool,
    pub progress_current: i64,
    pub progress_total: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
