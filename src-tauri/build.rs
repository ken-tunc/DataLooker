fn main() {
    // `sqlx::migrate!` embeds the files at compile time, and a proc macro alone
    // does not make cargo notice when they change.
    println!("cargo:rerun-if-changed=migrations");
    tauri_build::build()
}
