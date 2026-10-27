fn main() {
    println!("cargo:rerun-if-changed=icons");                             // a new icon rebuilds the app (cargo did not notice it before)
    tauri_build::build()
}
