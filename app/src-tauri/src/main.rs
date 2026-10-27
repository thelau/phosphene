// Phosphene, the Mac app: a native window around the same page and server as `npm run dev`.
//
// Built app: it starts the bundled server (studio/server.py, frozen with PyInstaller) on a free port of this computer, with
// the projects in ~/Documents/Phosphene and this machine's files (keys, the Krea sign-in, the log) in
// ~/Library/Application Support/Phosphene, shows "Starting Phosphene…" until the server answers, then opens the page.
// Development (`npm run app`): the window opens the live page of `npm run dev` (Vite), which refreshes on every change.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::DownloadEvent;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Server(Mutex<Option<Child>>);
// the server's port once it answers (0 before), and .phosphene files opened before that (a double-click that launched the app)
struct Opened { port: Mutex<u16>, waiting: Mutex<Vec<String>> }

// a project file double-clicked in Finder: the server imports it from where it is, then the page reloads on it
fn import_file(port: u16, path: &str, win: &tauri::WebviewWindow) {
    let body = serde_json::json!({ "path": path }).to_string();
    let ok = TcpStream::connect(("127.0.0.1", port)).and_then(|mut s| {
        write!(s, "POST /api/project-import-path HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)?;
        let mut answer = String::new();
        s.read_to_string(&mut answer)?;
        Ok(answer.contains("\"ok\": true"))
    }).unwrap_or(false);
    let js = if ok { "location.reload()".to_string() } else { format!("window.setStatus && setStatus({})", serde_json::json!(format!("Could not open {}: is it a Phosphene project file?", path))) };
    let _ = win.eval(&js);
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(8765)
}

// a download saved in ~/Downloads under its own name, never over a file already there ("name 2.zip")
fn unique(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|c| !c.exists()).unwrap()
}

fn start_server(app: &tauri::App, port: u16) -> std::io::Result<Child> {
    let res = app.path().resource_dir().expect("resources");
    let home = app.path().document_dir().expect("Documents").join("Phosphene");
    let support = app.path().data_dir().expect("Application Support").join("Phosphene");
    std::fs::create_dir_all(&home)?;
    std::fs::create_dir_all(&support)?;
    let log = std::fs::File::create(support.join("server.log"))?;
    Command::new(res.join("server").join("phosphene-server"))
        .env("PORT", port.to_string())
        .env("PHOSPHENE_HOME", &home)
        .env("PHOSPHENE_SUPPORT", &support)
        .env("PHOSPHENE_WEB", res.join("web"))
        .env("PHOSPHENE_FFMPEG", res.join("bin").join("ffmpeg"))
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Server(Mutex::new(None)))
        .manage(Opened { port: Mutex::new(0), waiting: Mutex::new(Vec::new()) })
        .setup(|app| {
            let dev = cfg!(debug_assertions);
            let port = if dev { 0 } else { free_port() };
            if dev { *app.state::<Opened>().port.lock().unwrap() = 8765; }      // npm run app:live: the dev server
            let downloads = app.path().download_dir().unwrap_or_else(|_| PathBuf::from("."));
            let first = if dev { WebviewUrl::External("http://localhost:5173".parse().unwrap()) } else { WebviewUrl::App("index.html".into()) };
            let win = WebviewWindowBuilder::new(app, "main", first)
                .title("Phosphene")
                .inner_size(1512.0, 945.0)
                .min_inner_size(1280.0, 720.0)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .on_download(move |_webview, event| {
                    if let DownloadEvent::Requested { destination, .. } = event {
                        let name = destination.file_name().and_then(|n| n.to_str()).unwrap_or("download").to_string();
                        *destination = unique(&downloads, &name);
                    }
                    true
                })
                .build()?;
            if !dev {
                let child = start_server(app, port)?;
                *app.state::<Server>().0.lock().unwrap() = Some(child);
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let t0 = Instant::now();
                    loop {
                        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                            let opened = handle.state::<Opened>();
                            *opened.port.lock().unwrap() = port;
                            let waiting: Vec<String> = opened.waiting.lock().unwrap().drain(..).collect();
                            for path in &waiting { import_file(port, path, &win); }
                            let _ = win.navigate(format!("http://localhost:{port}/").parse().unwrap());
                            return;
                        }
                        let gone = handle.state::<Server>().0.lock().unwrap().as_mut().map(|c| c.try_wait().ok().flatten().is_some()).unwrap_or(true);
                        if gone || t0.elapsed() > Duration::from_secs(60) {
                            let _ = win.eval("document.getElementById('msg').textContent = 'Phosphene could not start. Its log is in ~/Library/Application Support/Phosphene/server.log.'");
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(150));
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Phosphene could not start");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            let opened = handle.state::<Opened>();
            let port = *opened.port.lock().unwrap();
            for u in urls {
                if let Ok(path) = u.to_file_path() {
                    let path = path.to_string_lossy().to_string();
                    match (port, handle.get_webview_window("main")) {
                        (p, Some(win)) if p > 0 => import_file(p, &path, &win),
                        _ => opened.waiting.lock().unwrap().push(path),   // the server is still starting: imported when it answers
                    }
                }
            }
        }
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();                         // the server goes with the app
                let _ = child.wait();
            }
        }
    });
}
