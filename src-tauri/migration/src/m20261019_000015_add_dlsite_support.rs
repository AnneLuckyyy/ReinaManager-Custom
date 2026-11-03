//! 为 DLsite 预留独立数据列。
//!
//! 这是兼容当前宽列来源模型的增量迁移：不转换既有来源、不触碰 custom_data，
//! 也不迁入上游的 game_sources 表。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Games::Table)
                    .add_column_if_not_exists(ColumnDef::new(Games::DlsiteId).text().null())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Games::Table)
                    .add_column_if_not_exists(ColumnDef::new(Games::DlsiteData).text().null())
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Games::Table)
                    .drop_column(Games::DlsiteData)
                    .drop_column(Games::DlsiteId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Games {
    Table,
    DlsiteId,
    DlsiteData,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[async_std::test]
    async fn adds_only_nullable_dlsite_columns() {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE games (id INTEGER PRIMARY KEY, id_type TEXT NOT NULL, custom_data TEXT); \
                 INSERT INTO games(id, id_type, custom_data) VALUES (1, 'mixed', '{\"keep\":true}')",
            )
            .await
            .unwrap();

        Migration.up(&SchemaManager::new(&database)).await.unwrap();

        let row = database
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id_type, custom_data, dlsite_id, dlsite_data FROM games WHERE id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "id_type").unwrap(), "mixed");
        assert_eq!(
            row.try_get::<String>("", "custom_data").unwrap(),
            "{\"keep\":true}"
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "dlsite_id").unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "dlsite_data").unwrap(),
            None
        );
    }
}
