//! 游戏打包的可配置目录保护。
//!
//! 默认继续保护 `X:\\Games\\` 的直属目录；该设置属于数据库备份/恢复范围，
//! 不改变任何现有目录或游戏记录。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("user"))
                    .add_column(
                        ColumnDef::new(Alias::new("protect_games_root_children"))
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom("游戏打包目录保护迁移不可逆".to_string()))
    }
}
