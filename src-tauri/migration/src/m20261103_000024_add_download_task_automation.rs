//! 下载任务的自动入库/删除偏好。
//!
//! 旧任务默认关闭；迁移只增加布尔列，不触及下载文件、安装目录或游戏记录。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("tasks"))
                    .add_column(
                        ColumnDef::new(Alias::new("auto_import"))
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("tasks"))
                    .add_column(
                        ColumnDef::new(Alias::new("auto_delete"))
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("下载任务自动化偏好迁移不可逆".to_string()))
    }
}
