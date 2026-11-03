//! 为受控下载任务保存安全文件名与来源校验信息。
//!
//! 既有任务保持可空字段，继续使用原有临时文件路径；本迁移不触及 games、115 或用户文件。

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
                    .add_column_if_not_exists(ColumnDef::new(Tasks::FileName).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(
                        ColumnDef::new(Tasks::ChecksumAlgorithm).text().null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(ColumnDef::new(Tasks::ChecksumValue).text().null())
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .drop_column(Tasks::ChecksumValue)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .drop_column(Tasks::ChecksumAlgorithm)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .drop_column(Tasks::FileName)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Tasks {
    Table,
    FileName,
    ChecksumAlgorithm,
    ChecksumValue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[async_std::test]
    async fn adds_download_details_one_sqlite_column_at_a_time() {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL); \
                 INSERT INTO tasks(id, title) VALUES (1, 'keep')",
            )
            .await
            .unwrap();

        Migration.up(&SchemaManager::new(&database)).await.unwrap();

        let row = database
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT title, file_name, checksum_algorithm, checksum_value FROM tasks WHERE id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "title").unwrap(), "keep");
        assert_eq!(
            row.try_get::<Option<String>>("", "file_name").unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "checksum_algorithm")
                .unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "checksum_value").unwrap(),
            None
        );
    }
}
