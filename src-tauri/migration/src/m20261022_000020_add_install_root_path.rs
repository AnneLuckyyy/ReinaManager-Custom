//! 为后续资源站自动安装保存独立的游戏安装目录。
//!
//! 该列为空时保持现有下载与游戏管理行为不变；迁移不移动、不扫描也不删除任何用户文件。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(User::Table)
                    .add_column_if_not_exists(ColumnDef::new(User::InstallRootPath).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "此迁移无法回滚，请从迁移前备份恢复数据库".to_string(),
        ))
    }
}

#[derive(DeriveIden)]
enum User {
    Table,
    InstallRootPath,
}
