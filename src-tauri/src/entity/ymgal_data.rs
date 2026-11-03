//! YMGal 元数据 JSON 结构体
//!
//! 此文件定义了存储在 games.ymgal_data 列中的 JSON 数据结构。
//! 用于 YMGal 数据源的元数据。

use sea_orm::FromJsonQueryResult;
use serde::{Deserialize, Serialize};

/// YMGal 元数据结构（存储为 JSON）
///
/// 用于 YMGal 数据源
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, FromJsonQueryResult)]
#[serde(default)]
pub struct YmgalData {
    /// 封面图片 URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,

    /// 原始名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// 中文名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_cn: Option<String>,

    /// 别名列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,

    /// 简介/摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    /// 开发商
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,

    /// 源数据的原始日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,

    /// 是否为成人内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsfw: Option<bool>,
}
