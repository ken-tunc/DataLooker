use sqlx::{PgConnection, Row};

use crate::drivers::TransactionState;

/// The server's code for a statement sent inside a failed transaction.
const IN_FAILED_TRANSACTION: &str = "25P02";

/// Whether the reader left a transaction open on this session. sqlx only knows
/// about transactions it began, so the server is asked: inside a transaction
/// `now()` is when it began. A simple query, because the extended protocol's
/// Bind and Execute are two instants apart even outside a transaction. A
/// failed transaction refuses the question with the complaint the reader needs
/// to see.
pub async fn in_transaction(conn: &mut PgConnection) -> Result<bool, sqlx::Error> {
    sqlx::raw_sql("SELECT now() <> statement_timestamp()")
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)
}

/// Where the session stands. The server says so after every statement, but
/// sqlx keeps that to itself, so it is asked again.
pub async fn state(conn: &mut PgConnection) -> Result<TransactionState, sqlx::Error> {
    match in_transaction(conn).await {
        Ok(true) => Ok(TransactionState::Open),
        Ok(false) => Ok(TransactionState::Idle),
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some(IN_FAILED_TRANSACTION) => {
            Ok(TransactionState::Failed)
        }
        Err(e) => Err(e),
    }
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use crate::drivers::postgres::testing::*;
    use crate::drivers::TransactionState;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_session_says_where_the_readers_transaction_stands() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        assert_eq!(session.transaction_state(), TransactionState::Idle);

        run(&session, "BEGIN").await.unwrap();
        assert_eq!(session.transaction_state(), TransactionState::Open);

        run(&session, "SELEC 1").await.unwrap_err();
        assert_eq!(session.transaction_state(), TransactionState::Failed);

        // A statement refused inside the failed transaction leaves it failed.
        run(&session, "SELECT 1").await.unwrap_err();
        assert_eq!(session.transaction_state(), TransactionState::Failed);

        run(&session, "ROLLBACK").await.unwrap();
        assert_eq!(session.transaction_state(), TransactionState::Idle);

        // An error outside a transaction leaves nothing open.
        run(&session, "SELEC 1").await.unwrap_err();
        assert_eq!(session.transaction_state(), TransactionState::Idle);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_transaction_the_driver_ends_for_itself_is_not_the_readers() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        session
            .explain("EXPLAIN (FORMAT JSON) SELECT 1", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(session.transaction_state(), TransactionState::Idle);

        run(&session, "BEGIN").await.unwrap();
        session
            .explain("EXPLAIN (FORMAT JSON) SELECT 1", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(session.transaction_state(), TransactionState::Open);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_statement_leaves_no_transaction() {
        let Some(session) = session_or_skip().await else {
            return;
        };
        run(&session, "BEGIN").await.unwrap();
        assert_eq!(session.transaction_state(), TransactionState::Open);
        let cancel = CancellationToken::new();
        let waiting = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            waiting.cancel();
        });

        session
            .execute("SELECT pg_sleep(30)", ROW_LIMIT, &cancel)
            .await
            .unwrap_err();

        // The connection was dropped, and the server rolled back what it held.
        assert_eq!(session.transaction_state(), TransactionState::Idle);
        run(&session, "SELECT 1").await.unwrap();
        assert_eq!(session.transaction_state(), TransactionState::Idle);
    }
}
