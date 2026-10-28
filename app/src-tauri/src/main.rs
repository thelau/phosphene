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

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Listener, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::DialogExt;

struct Server(Mutex<Option<Child>>);
// the server's port once it answers (0 before), and .phos files opened before that (a double-click that launched the app)
// one lock for both, so a file opened while the server starts is never lost between "not ready yet" and "ready"
struct Opened(Mutex<(u16, Vec<String>)>);

// a project file double-clicked in Finder: the server imports it from where it is, then the page reloads on it
fn import_file(port: u16, path: &str, win: &tauri::WebviewWindow) {
    let body = serde_json::json!({ "path": path }).to_string();
    let ok = TcpStream::connect(("127.0.0.1", port)).and_then(|mut s| {
        write!(s, "POST /api/project-import-path HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)?;
        let mut answer = String::new();
        s.read_to_string(&mut answer)?;
        Ok(answer.contains("\"ok\": true"))
    }).unwrap_or(false);
    let msg = serde_json::json!(format!("Could not open {}: is it a Phosphene project file?", path));
    let js = if ok { "location.reload()".to_string() } else { format!("window.setStatus ? setStatus({msg}) : alert({msg})") };
    let _ = win.eval(&js);
}

// the same port every launch when it is free, so the Krea sign-in comes back to the same address (Krea registers the app
// for one address: a new port meant registering again at every sign-in); any free port only when that one is taken
const HOME_PORT: u16 = 47615;
fn free_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", HOME_PORT)).is_ok() {
        return HOME_PORT;
    }
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

// the menu bar. The page gets every shortcut first (WebKit), so the ones it handles itself (⌘Z, ⌘S, ⌘A) are not doubled here;
// the menu adds what a Mac app has: New Project ⌘N, Open Project File… ⌘O (the macOS file dialog), Export Project… ⌘E, Curate ⌘1,
// Film ⌘2, the Keys, and the standard Edit menu (copy and paste in text fields)
fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str, key: Option<&str>| MenuItem::with_id(app, id, label, true, key);
    let about = AboutMetadata {                                        // About Phosphene: the icon (also when run unbundled, app:live), what it is
        name: Some("Phosphene".into()),
        version: Some(app.package_info().version.to_string()),
        icon: tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok(),
        credits: Some("Films around a brand mark: AI images where the mark always sits at the same place and size, cut to a synthesized sound.".into()),
        copyright: Some("Alpha".into()),
        ..Default::default()
    };
    Menu::with_items(app, &[
        &Submenu::with_items(app, "Phosphene", true, &[
            &PredefinedMenuItem::about(app, Some("About Phosphene"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ])?,
        &Submenu::with_items(app, "File", true, &[
            &item("new_project", "New Project…", Some("CmdOrCtrl+N"))?,
            &item("open_project", "Open Project File…", Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("export_project", "Export Project…", Some("CmdOrCtrl+E"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ])?,
        &Submenu::with_items(app, "Edit", true, &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ])?,
        &Submenu::with_items(app, "View", true, &[
            &item("curate", "Curate", Some("CmdOrCtrl+1"))?,
            &item("film", "Film", Some("CmdOrCtrl+2"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ])?,
        &Submenu::with_items(app, "Window", true, &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ])?,
        &Submenu::with_items(app, "Help", true, &[&item("keys", "Keyboard Shortcuts", None)?])?,
    ])
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(win) = app.get_webview_window("main") else { return };
    let js = match id {
        "new_project" => "openProjectForm('new')",
        "export_project" => "document.getElementById('projectBtn') && window.exportProject && exportProject()",
        "settings" => "toggleSettings(true)",
        "curate" => "setMode('curate')",
        "film" => "setMode('film')",
        "keys" => "toggleKeys()",
        "open_project" => {
            let handle = app.clone();
            app.dialog().file().add_filter("Phosphene project", &["phos", "phosphene", "zip"]).pick_file(move |file| {
                let Some(path) = file.and_then(|f| f.into_path().ok()) else { return };
                let port = handle.state::<Opened>().0.lock().unwrap().0;
                if let Some(win) = handle.get_webview_window("main") {
                    if port > 0 { import_file(port, &path.to_string_lossy(), &win); }   // the dialog's callback is off the main thread
                }
            });
            return;
        }
        _ => return,
    };
    let _ = win.eval(js);
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
        .plugin(tauri_plugin_dialog::init())
        .menu(menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .manage(Server(Mutex::new(None)))
        .manage(Opened(Mutex::new((0, Vec::new()))))
        .setup(|app| {
            // the page's Import project…: the same macOS file dialog and import as the menu's Open Project File… (⌘O)
            let handle = app.handle().clone();
            app.listen_any("open-project-file", move |_| on_menu(&handle, "open_project"));
            let dev = cfg!(debug_assertions);
            let port = if dev { 0 } else { free_port() };
            if dev { app.state::<Opened>().0.lock().unwrap().0 = 8765; }       // npm run app:live: the dev server
            let downloads = app.path().download_dir().unwrap_or_else(|_| PathBuf::from("."));
            let first = if dev { WebviewUrl::External("http://localhost:5173".parse().unwrap()) } else { WebviewUrl::App("index.html".into()) };
            let win = WebviewWindowBuilder::new(app, "main", first)
                .title("Phosphene")
                .inner_size(1512.0, 945.0)
                .min_inner_size(1280.0, 720.0)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(20.0, 21.0))   // the window's buttons centred in the page's 56 px top bar
                // never suspended when hidden: after ~4 min behind other windows WebKit suspended the page's process and its audio session,
                // and the sound stayed silent (every context still 'running') until a reload; macOS 14+ (WKInactiveSchedulingPolicy::None)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
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
                            let state = handle.state::<Opened>();
                            let waiting: Vec<String> = {
                                let mut o = state.0.lock().unwrap();
                                o.0 = port;
                                o.1.drain(..).collect()
                            };
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
            for u in urls {
                let Ok(path) = u.to_file_path() else { continue };
                let path = path.to_string_lossy().to_string();
                let state = handle.state::<Opened>();
                let mut o = state.0.lock().unwrap();
                match (o.0, handle.get_webview_window("main")) {
                    (p, Some(win)) if p > 0 => {
                        drop(o);
                        std::thread::spawn(move || import_file(p, &path, &win));   // a big project takes a while: never on the main thread
                    }
                    _ => o.1.push(path),                                           // the server is still starting: imported when it answers
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
