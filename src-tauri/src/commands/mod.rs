//! The window's way into `App`. `commands!` is the one declaration Tauri is
//! handed, each signature is checked against, and `src/bindings/Commands.ts` is
//! generated from, so a changed command fails the frontend's type check.

pub mod agents;
pub mod completion;
pub mod connection;
pub mod edit;
pub mod lsp;
pub mod preview;
pub mod query;
pub mod schema;
pub mod shell;

use std::future::Future;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use crate::app::agents::AgentAccess;
use crate::app::completion::Completion;
use crate::app::connections::SaveConnectionInput;
use crate::app::edit::TableEdits;
use crate::app::preview::PreviewRequest;
use crate::app::syntax::SyntaxError;
use crate::app::App;
use crate::db::connection::ConnectionRecord;
use crate::db::history::HistoryEntry;
use crate::drivers::{Column, QueryResult, SchemaTree, TableDefinition, TablePage, TableShape};
use crate::error::AppError;
use crate::lsp::{LanguageServerState, LspExit, LspMessage};
use crate::shell::ShellExit;

/// One command, as the frontend sees it: what it sends and what comes back.
/// The fields are never read — the type is here to be written out.
#[derive(TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[allow(dead_code)]
struct Call<A, R> {
    args: A,
    returns: R,
}

/// Checked at compile time, so the bindings cannot disagree with the function.
fn takes<A, R, F, Fut>(_: F)
where
    F: Fn(A, State<'static, Arc<App>>) -> Fut,
    Fut: Future<Output = Result<R, AppError>>,
{
}

fn takes_nothing<R, F, Fut>(_: F)
where
    F: Fn(State<'static, Arc<App>>) -> Fut,
    Fut: Future<Output = Result<R, AppError>>,
{
}

macro_rules! commands {
    ($($module:ident::$name:ident($($args:ty)?) -> $returns:ty;)*) => {
        pub fn handler<R: tauri::Runtime>(
        ) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($module::$name),*]
        }

        /// Every command the window may invoke, by name.
        #[derive(TS)]
        #[ts(export, export_to = "../../src/bindings/")]
        #[allow(dead_code)]
        struct Commands {
            $($name: Call<commands!(@args $($args)?), $returns>,)*
        }

        #[allow(dead_code)]
        fn signatures() {
            $(commands!(@check $module::$name, $returns $(, $args)?);)*
        }
    };
    (@args) => { () };
    (@args $args:ty) => { $args };
    (@check $module:ident::$name:ident, $returns:ty) => {
        takes_nothing::<$returns, _, _>($module::$name)
    };
    (@check $module:ident::$name:ident, $returns:ty, $args:ty) => {
        takes::<$args, $returns, _, _>($module::$name)
    };
}

commands! {
    connection::list_connections() -> Vec<ConnectionRecord>;
    connection::save_connection(SaveConnectionInput) -> String;
    connection::delete_connection(ConnectionArgs) -> ();
    query::test_connection(ConnectionArgs) -> u32;
    query::execute_query(ExecuteQueryArgs) -> QueryResult;
    query::cancel_query(CancelQueryArgs) -> ();
    query::check_syntax(CheckSyntaxArgs) -> Vec<SyntaxError>;
    query::query_history(ConnectionArgs) -> Vec<HistoryEntry>;
    schema::schema_tree(ConnectionArgs) -> SchemaTree;
    schema::table_columns(TableArgs) -> Vec<Column>;
    schema::table_definition(TableArgs) -> TableDefinition;
    preview::preview_table(PreviewRequest) -> TablePage;
    edit::table_shape(TableArgs) -> TableShape;
    edit::commit_table_edits(TableEdits) -> u32;
    shell::run_connection_command(ConnectionArgs) -> ();
    shell::stop_connection_command(ConnectionArgs) -> ();
    shell::running_connection_commands() -> Vec<String>;
    completion::complete(CompleteArgs) -> Completion;
    lsp::start_language_server(ConnectionArgs) -> lsp::Capabilities;
    lsp::send_to_language_server(LanguageServerMessageArgs) -> ();
    lsp::stop_language_server(ConnectionArgs) -> ();
    lsp::language_server_state(ConnectionArgs) -> LanguageServerState;
    lsp::install_language_server(ConnectionArgs) -> ();
    agents::agent_access() -> AgentAccess;
    agents::set_agent_access(AgentAccessArgs) -> AgentAccess;
}

/// A command that is about one connection and nothing more.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ConnectionArgs {
    pub connection_id: String,
}

/// A command that is about one table of a connection.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TableArgs {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
}

/// `query_id` is the caller's handle on the running statement, and what
/// `cancel_query` is handed to stop it.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ExecuteQueryArgs {
    pub connection_id: String,
    pub sql: String,
    pub query_id: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CancelQueryArgs {
    pub query_id: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CheckSyntaxArgs {
    pub sql: String,
}

/// One JSON-RPC message, as the text the server is handed.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LanguageServerMessageArgs {
    pub connection_id: String,
    pub message: String,
}

/// `cursor` is a UTF-16 offset into `text`, which is the whole of the
/// editor's document.
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CompleteArgs {
    pub connection_id: String,
    pub text: String,
    pub cursor: u32,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AgentAccessArgs {
    pub enabled: bool,
}

/// What the backend announces unasked, each with what it carries. `emit` is
/// the only way one is sent, so what goes out is what the bindings say.
macro_rules! events {
    ($($event:ident = $name:literal => $payload:ty;)*) => {
        $(
            pub mod $event {
                use super::*;

                pub fn emit(handle: &AppHandle, payload: $payload) {
                    // A window that is gone has nobody to tell.
                    let _ = handle.emit($name, payload);
                }
            }
        )*

        /// Every event the window may listen for, by name.
        #[derive(TS)]
        #[ts(export, export_to = "../../src/bindings/")]
        #[allow(dead_code)]
        struct Events {
            $(#[ts(rename = $name)] $event: $payload,)*
        }
    };
}

events! {
    shell_exit = "shell:exit" => ShellExit;
    lsp_message = "lsp:message" => LspMessage;
    lsp_exit = "lsp:exit" => LspExit;
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewWindow, WebviewWindowBuilder};

    use super::*;

    /// A window of the mock runtime, holding the commands and the app they
    /// reach, as `lib.rs` sets them up.
    fn window() -> WebviewWindow<tauri::test::MockRuntime> {
        let app = tauri::async_runtime::block_on(crate::app::tests::app());
        let app = mock_builder()
            .manage(Arc::new(app))
            .invoke_handler(handler())
            .build(mock_context(noop_assets()))
            .expect("the mock app");
        WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("the mock window")
    }

    /// Sends `body` the way `invoke` in `lib/invoke.ts` does, and answers with
    /// what came back.
    fn send(
        window: &WebviewWindow<tauri::test::MockRuntime>,
        command: &str,
        body: Value,
    ) -> Result<Value, Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|answer| answer.deserialize::<Value>().expect("an answer in JSON"))
    }

    #[test]
    fn a_command_takes_its_arguments_under_args_as_the_bindings_write_them() {
        let window = window();

        assert_eq!(send(&window, "list_connections", json!({})), Ok(json!([])));
        assert_eq!(
            send(
                &window,
                "query_history",
                json!({ "args": { "connection_id": "ghost" } })
            ),
            Ok(json!([]))
        );

        // Arguments outside `args` are refused.
        assert!(send(&window, "query_history", json!({ "connectionId": "ghost" })).is_err());
        assert!(send(
            &window,
            "query_history",
            json!({ "args": { "connectionId": "ghost" } })
        )
        .is_err());
    }
}
