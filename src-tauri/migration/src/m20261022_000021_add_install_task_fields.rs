//! 为后续 Shionlib 自动安装链路预留任务语义与恢复信息。
//!
//! 旧下载任务维持 `task_kind = download`，其余新增列均为空；本迁移不触发下载、
//! 解压、移动、扫描或游戏资料写入。SQLite 每次只追加一列，避免组合 ALTER TABLE。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(
                        ColumnDef::new(Tasks::TaskKind)
                            .string()
                            .not_null()
                            .default("download"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::InstallStage).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::InstallRootPath).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::SourceProvider).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::SourceResourceId).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::ArchiveFormat).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::MetadataJson).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(
                        ColumnDef::new(Tasks::InstallResultJson).text().null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::ErrorCode).text().null())
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
enum Tasks {
    Table,
    TaskKind,
    InstallStage,
    InstallRootPath,
    SourceProvider,
    SourceResourceId,
    ArchiveFormat,
    MetadataJson,
    InstallResultJson,
    ErrorCode,
}
