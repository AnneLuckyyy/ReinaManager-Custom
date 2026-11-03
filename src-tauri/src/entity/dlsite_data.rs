//! DLsite 数据结构。
//!
//! 第一阶段只定义本地快照结构；不在此处发起网络请求或改变现有来源的合并规则。

use sea_orm::FromJsonQueryResult;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, FromJsonQueryResult)]
pub struct DlsiteData {
    pub image: Option<String>,
    pub name: Option<String>,
    pub summary: Option<String>,
    pub tags: Option<Vec<String>>,
    pub developer: Option<String>,
    pub nsfw: Option<bool>,
    pub date: Option<String>,
}
