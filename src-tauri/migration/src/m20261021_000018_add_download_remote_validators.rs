//! 为受控下载任务保存来源版本标记。
//!
//! 既有任务保持空标记和原有断点文件；本迁移不触及 games、115、完成文件或用户目录。

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
                    .add_column_if_not_exists(ColumnDef::new(Tasks::RemoteEtag).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .add_column_if_not_exists(
                        ColumnDef::new(Tasks::RemoteLastModified).text().null(),
                    )
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
                    .drop_column(Tasks::RemoteLastModified)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Tasks::Table)
                    .drop_column(Tasks::RemoteEtag)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Tasks {
    Table,
    RemoteEtag,
    RemoteLastModified,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[async_std::test]
    async fn adds_remote_validators_one_sqlite_column_at_a_time() {
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
                "SELECT title, remote_etag, remote_last_modified FROM tasks WHERE id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "title").unwrap(), "keep");
        assert_eq!(
            row.try_get::<Option<String>>("", "remote_etag").unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "remote_last_modified")
                .unwrap(),
            None
        );
    }
}
