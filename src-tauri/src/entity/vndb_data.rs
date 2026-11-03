//! VNDB 元数据 JSON 结构体
//!
//! 此文件定义了存储在 games.vndb_data 列中的 JSON 数据结构。
//! 不再作为独立的数据表实体使用。

use sea_orm::FromJsonQueryResult;
use serde::{Deserialize, Serialize};

/// VNDB 元数据结构（存储为 JSON）
///
/// 注意：
/// - 不包含 game_id（由 games 表主键关联）
/// - 包含 date 字段用于记录源数据的原始日期
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default, FromJsonQueryResult)]
#[serde(default)]
pub struct VndbData {
    /// 封面图片 URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,

    /// 原始名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// 中文名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_cn: Option<String>,

    /// 所有标题（包括别名）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_titles: Option<Vec<String>>,

    /// 别名列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,

    /// 简介/摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    /// 标签列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// 平均游戏时长（小时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_hours: Option<f64>,

    /// 开发商
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,

    /// 评分
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,

    /// 源数据的原始日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,

    /// 是否为成人内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsfw: Option<bool>,
}
