//! 自定义元数据 JSON 结构体
//!
//! 此文件定义了存储在 games.custom_data 列中的 JSON 数据结构。
//! 用于替代原有的 other_data 表和 custom_name/custom_cover 字段。

use sea_orm::FromJsonQueryResult;
use serde::{Deserialize, Serialize};

/// 自定义元数据结构（存储为 JSON）
///
/// 用于用户自定义的游戏数据，包括：
/// - 手动添加的游戏
/// - 从 Whitecloud 等其他来源导入的游戏
/// - 用户自定义的名称和封面
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default, FromJsonQueryResult)]
#[serde(default)]
pub struct CustomData {
    /// 自定义封面图片路径或 URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,

    /// 自定义名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// 别名列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,

    /// 简介/摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    /// 标签列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// 开发商
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,

    /// 发布日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,

    /// 是否为成人内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsfw: Option<bool>,

    /// 备用启动路径列表
    #[serde(rename = "extraLocalPaths", skip_serializing_if = "Option::is_none")]
    pub extra_local_paths: Option<Vec<String>>,

    /// 用于匹配网盘游戏压缩包的目录名
    #[serde(rename = "backupMatchName", skip_serializing_if = "Option::is_none")]
    pub backup_match_name: Option<String>,

    /// 是否由用户明确设置（包括明确清空），用于避免批量补齐覆盖用户选择
    #[serde(
        rename = "backupMatchNameManual",
        skip_serializing_if = "Option::is_none"
    )]
    pub backup_match_name_manual: Option<bool>,
}
