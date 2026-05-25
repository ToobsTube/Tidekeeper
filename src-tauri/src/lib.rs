use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub mods_folder: Option<String>,
    pub setup_complete: Option<bool>,
    pub nexus_client_id: Option<String>,
    pub nexus_token: Option<String>,
    pub nexus_api_key: Option<String>,
    pub profiles: Option<HashMap<String, Vec<String>>>,
    pub active_profile: Option<String>,
    pub download_dir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    pub name: String,
    pub enabled: bool,
    pub path: String,
    pub mod_type: String, // "script" | "pak"
}

// Returned by peek_zip_name so the UI knows whether to show the name prompt
// and what hint to display.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZipInfo {
    pub suggested_name: String,
    pub install_type: String,  // "game_relative" | "pak" | "script"
    pub needs_name_prompt: bool,
}

#[derive(Deserialize)]
struct DownloadLink {
    #[serde(rename = "URI")]
    uri: String,
}

#[derive(Default)]
struct NxmQueue(Mutex<Vec<String>>);

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("config.json")
}

fn load_config(app: &AppHandle) -> Option<Config> {
    let p = config_path(app);
    if !p.exists() { return None; }
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn save_config_inner(app: &AppHandle, config: &Config) -> Result<(), String> {
    let p = config_path(app);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config(app: AppHandle) -> Option<Config> {
    load_config(&app)
}

#[tauri::command]
fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    save_config_inner(&app, &config)
}

#[tauri::command]
fn validate_folder(path: String) -> bool {
    PathBuf::from(&path).is_dir()
}

#[tauri::command]
fn scan_mods(app: AppHandle) -> Result<Vec<ModEntry>, String> {
    let config = load_config(&app).ok_or("No config found")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;

    let mut mods: Vec<ModEntry> = Vec::new();

    // UE4SS script mods
    let script_dir = PathBuf::from(&mods_folder);
    if script_dir.is_dir() {
        for entry in fs::read_dir(&script_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let path = entry.path();
            mods.push(ModEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                enabled: path.join("enabled.txt").exists(),
                path: path.to_string_lossy().into_owned(),
                mod_type: "script".into(),
            });
        }
    }

    // Pak/blueprint mods in Content\Paks\LogicMods
    if let Ok(inner) = derive_inner_game_folder(&mods_folder) {
        let pak_dir = inner.join("Content").join("Paks").join("LogicMods");
        if pak_dir.is_dir() {
            for entry in fs::read_dir(&pak_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                let path = entry.path();
                let raw = entry.file_name().to_string_lossy().into_owned();
                let (name, enabled) = if raw.ends_with(".disabled") {
                    (raw.trim_end_matches(".disabled").to_string(), false)
                } else {
                    (raw, true)
                };
                mods.push(ModEntry {
                    name,
                    enabled,
                    path: path.to_string_lossy().into_owned(),
                    mod_type: "pak".into(),
                });
            }
        }
    }

    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(mods)
}

#[tauri::command]
fn toggle_mod(mod_path: String, enabled: bool) -> Result<String, String> {
    let path = PathBuf::from(&mod_path);
    let parent = path.parent().ok_or("Invalid mod path")?;
    let name = path.file_name().ok_or("Invalid mod path")?.to_string_lossy().into_owned();

    // Pak mod: identified by living inside a LogicMods folder
    let is_pak = parent.file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("logicmods"))
        .unwrap_or(false)
        || name.ends_with(".disabled");

    if is_pak {
        let base_name = name.trim_end_matches(".disabled");
        let enabled_path  = parent.join(base_name);
        let disabled_path = parent.join(format!("{}.disabled", base_name));
        let (from, to) = if enabled { (&disabled_path, &enabled_path) } else { (&enabled_path, &disabled_path) };
        fs::rename(from, to).map_err(|e| e.to_string())?;
        Ok(to.to_string_lossy().into_owned())
    } else {
        // Script mod: enabled.txt presence controls loading
        let enabled_file = path.join("enabled.txt");
        if enabled {
            fs::write(&enabled_file, "").map_err(|e| e.to_string())?;
        } else if enabled_file.exists() {
            fs::remove_file(&enabled_file).map_err(|e| e.to_string())?;
        }
        Ok(mod_path)
    }
}

#[tauri::command]
fn uninstall_mod(app: AppHandle, mod_path: String) -> Result<(), String> {
    let mod_name = PathBuf::from(&mod_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    fs::remove_dir_all(&mod_path).map_err(|e| e.to_string())?;

    // Remove from all profiles so no profile points to a deleted mod
    if let Some(mut config) = load_config(&app) {
        if let Some(profiles) = config.profiles.as_mut() {
            for mods in profiles.values_mut() {
                mods.retain(|m| m != &mod_name);
            }
        }
        let _ = save_config_inner(&app, &config);
    }

    Ok(())
}

// ── ZIP installation ─────────────────────────────────────────────────────────

// Subnautica 2 has two mod locations, both derivable from the UE4SS mods folder:
//
//   mods_folder = .../Subnautica2/Binaries/Win64/ue4ss/Mods   (configured by user)
//   inner_game  = .../Subnautica2/                            (4 levels up)
//   logic_mods  = inner_game/Binaries/Content/Paks/LogicMods  (pak/blueprint mods)
//
// ZIP patterns we handle:
//   "game_relative" — root dir is "Subnautica2/" → strip root, extract to inner_game
//   "pak"           — contains .pak/.ucas/.utoc → strip root, extract to logic_mods/<name>/
//   "script"        — Lua/other → strip root, extract to mods_folder/<name>/

fn derive_inner_game_folder(mods_folder: &str) -> Result<PathBuf, String> {
    PathBuf::from(mods_folder)
        .ancestors()
        .nth(4)
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot derive game folder from mods path — verify your mods folder setting".to_string())
}

fn analyze_zip(data: &[u8], zip_stem: &str) -> Result<ZipInfo, String> {
    let cursor = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let mut first_root: Option<String> = None;
    let mut has_pak = false;
    let mut first_pak_stem: Option<String> = None;
    let mut embedded_mod_name: Option<String> = None;

    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            let fname = file.name();
            let fname_lower = fname.to_lowercase();

            if fname_lower.ends_with(".pak") || fname_lower.ends_with(".ucas") || fname_lower.ends_with(".utoc") {
                has_pak = true;
                if first_pak_stem.is_none() {
                    first_pak_stem = PathBuf::from(fname)
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned());
                }
            }

            let path = PathBuf::from(fname);
            let comps: Vec<_> = path.components().collect();

            if first_root.is_none() {
                first_root = comps.first()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned());
            }

            // For game-relative ZIPs, find the mod name embedded after "Mods/" or "LogicMods/"
            if embedded_mod_name.is_none() {
                for (idx, comp) in comps.iter().enumerate() {
                    let c = comp.as_os_str().to_string_lossy().to_lowercase();
                    if (c == "mods" || c == "logicmods") && idx + 1 < comps.len() {
                        let name = comps[idx + 1].as_os_str().to_string_lossy().into_owned();
                        // Must look like a folder name, not a file
                        if !name.contains('.') && !name.is_empty() {
                            embedded_mod_name = Some(name);
                            break;
                        }
                    }
                }
            }
        }
    }

    let root_lower = first_root.as_deref().unwrap_or("").to_lowercase();

    if root_lower == "subnautica2" {
        Ok(ZipInfo {
            suggested_name: embedded_mod_name.unwrap_or_else(|| zip_stem.to_string()),
            install_type: "game_relative".into(),
            needs_name_prompt: false,
        })
    } else if root_lower == "logicmods" {
        // Prompt only if we couldn't find a file stem (extremely rare)
        let found = first_pak_stem.is_some();
        Ok(ZipInfo {
            suggested_name: first_pak_stem.unwrap_or_else(|| zip_stem.to_string()),
            install_type: "pak".into(),
            needs_name_prompt: !found,
        })
    } else if has_pak {
        // Root dir IS the mod name
        Ok(ZipInfo {
            suggested_name: first_root.clone().unwrap_or_else(|| zip_stem.to_string()),
            install_type: "pak".into(),
            needs_name_prompt: first_root.is_none(),
        })
    } else {
        // Root dir IS the mod name
        Ok(ZipInfo {
            suggested_name: first_root.clone().unwrap_or_else(|| zip_stem.to_string()),
            install_type: "script".into(),
            needs_name_prompt: first_root.is_none(),
        })
    }
}

// Strip the first path component from every ZIP entry and write to `base`.
// All three install types reduce to this operation with different base dirs.
fn extract_strip_one(data: Vec<u8>, base: &PathBuf) -> Result<(), String> {
    let cursor = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = PathBuf::from(file.name());
        // Reject path-traversal attempts
        if raw.components().any(|c| c.as_os_str() == "..") { continue; }
        let mut comps = raw.components();
        comps.next(); // drop the top-level component
        let rel = comps.as_path().to_path_buf();
        if rel.as_os_str().is_empty() { continue; } // was just the root dir entry
        let out = base.join(&rel);
        if file.name().ends_with('/') {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
            io::copy(&mut file, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Detect ZIP type and route files to the correct game location.
// `mod_name` is the user-chosen display name; ignored for game_relative installs.
fn install_zip_bytes(data: Vec<u8>, mods_folder: &str, zip_stem: &str, mod_name: &str) -> Result<String, String> {
    let info = analyze_zip(&data, zip_stem)?;

    match info.install_type.as_str() {
        "game_relative" => {
            // ZIP mirrors the full game folder tree starting at "Subnautica2/".
            // Strip that root and extract directly into the inner game folder so
            // both the pak files and the Lua scripts land in the right places.
            let inner = derive_inner_game_folder(mods_folder)?;
            extract_strip_one(data, &inner)?;
            Ok(info.suggested_name)
        }
        "pak" => {
            // Pak/IoStore mod (.pak + .ucas + .utoc).
            // Place files inside a named subfolder in LogicMods so each mod is
            // self-contained and easy to identify/remove, matching how multi-file
            // mods like AxumMetalFarm ship their ZIPs.
            let inner = derive_inner_game_folder(mods_folder)?;
            let dest = inner
                .join("Content").join("Paks")
                .join("LogicMods").join(mod_name);
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            extract_strip_one(data, &dest)?;
            Ok(mod_name.to_string())
        }
        _ => {
            // UE4SS Lua script mod — goes in the configured mods folder.
            let dest = PathBuf::from(mods_folder).join(mod_name);
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            extract_strip_one(data, &dest)?;
            Ok(mod_name.to_string())
        }
    }
}

#[tauri::command]
fn peek_zip_name(zip_path: String) -> Result<ZipInfo, String> {
    let data = fs::read(&zip_path).map_err(|e| e.to_string())?;
    let zip_stem = PathBuf::from(&zip_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());
    analyze_zip(&data, &zip_stem)
}

#[tauri::command]
fn install_from_zip(app: AppHandle, zip_path: String, mod_name: String) -> Result<String, String> {
    let config = load_config(&app).ok_or("No config found")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let data = fs::read(&zip_path).map_err(|e| e.to_string())?;
    let zip_stem = PathBuf::from(&zip_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());
    install_zip_bytes(data, &mods_folder, &zip_stem, mod_name.trim())
}

// ── NXM protocol ─────────────────────────────────────────────────────────────

async fn process_nxm(app: &AppHandle, nxm_url: String) -> Result<String, String> {
    // Parse nxm://subnautica2/mods/123/files/456?key=abc&expires=123
    let without_scheme = nxm_url.trim_start_matches("nxm://");
    let (path, query) = without_scheme.split_once('?').unwrap_or((without_scheme, ""));
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 5 {
        return Err(format!("Invalid NXM URL: {}", nxm_url));
    }
    let game    = parts[0];
    let mod_id  = parts[2];
    let file_id = parts[4];

    let mut key     = "";
    let mut expires = "";
    for param in query.split('&') {
        if let Some(v) = param.strip_prefix("key=")     { key = v; }
        if let Some(v) = param.strip_prefix("expires=") { expires = v; }
    }

    let config      = load_config(app).ok_or("No config — please complete setup first")?;
    let api_key     = config.nexus_api_key.clone().ok_or("No Nexus API key configured")?;
    let mods_folder = config.mods_folder.clone().ok_or("No mods folder configured")?;

    let download_dir = config.download_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_data_dir().expect("app data dir").join("downloads"));
    fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;

    let client  = Client::new();
    let api_url = format!(
        "https://api.nexusmods.com/v1/games/{game}/mods/{mod_id}/files/{file_id}/download_link.json?key={key}&expires={expires}"
    );
    let links: Vec<DownloadLink> = client
        .get(&api_url)
        .header("apikey", &api_key)
        .header("Application-Name", "Tidekeeper")
        .header("Application-Version", "0.1.0")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| format!("Failed to parse download links: {}", e))?;

    let uri = links.into_iter().next().ok_or("No download links returned")?.uri;

    let filename = uri.split('/').last()
        .and_then(|s| s.split('?').next())
        .unwrap_or("mod.zip")
        .to_string();

    let _ = app.emit("nxm-started", &filename);

    let bytes = client
        .get(&uri)
        .send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;

    fs::write(download_dir.join(&filename), &bytes).map_err(|e| e.to_string())?;

    let zip_stem = PathBuf::from(&filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());

    // Use auto-detected name; NXM installs don't need a user prompt
    let info = analyze_zip(&bytes, &zip_stem)?;
    let installed = install_zip_bytes(bytes.to_vec(), &mods_folder, &zip_stem, &info.suggested_name)?;

    let _ = app.emit("nxm-installed", &installed);
    Ok(installed)
}

#[tauri::command]
async fn handle_nxm(app: AppHandle, nxm_url: String) -> Result<String, String> {
    process_nxm(&app, nxm_url).await
}

#[tauri::command]
fn get_pending_nxm(app: AppHandle) -> Option<String> {
    app.state::<NxmQueue>().0.lock().ok()?.pop()
}

// ── Profiles ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn switch_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let mut config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.clone().ok_or("No mods folder configured")?;
    let dir = PathBuf::from(&mods_folder);

    let profiles = config.profiles.get_or_insert_with(HashMap::new);
    let enabled_mods: Vec<String> = profiles
        .get(&profile_name)
        .cloned()
        .unwrap_or_default();

    if dir.is_dir() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let mod_name = entry.file_name().to_string_lossy().into_owned();
            let enabled_file = entry.path().join("enabled.txt");
            if enabled_mods.contains(&mod_name) {
                fs::write(&enabled_file, "").map_err(|e| e.to_string())?;
            } else if enabled_file.exists() {
                fs::remove_file(&enabled_file).map_err(|e| e.to_string())?;
            }
        }
    }

    config.active_profile = Some(profile_name);
    save_config_inner(&app, &config)
}

#[tauri::command]
fn save_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let mut config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.clone().ok_or("No mods folder configured")?;
    let dir = PathBuf::from(&mods_folder);

    let enabled: Vec<String> = if dir.is_dir() {
        fs::read_dir(&dir).map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| e.path().join("enabled.txt").exists())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect()
    } else { vec![] };

    config.profiles.get_or_insert_with(HashMap::new).insert(profile_name.clone(), enabled);
    config.active_profile = Some(profile_name);
    save_config_inner(&app, &config)
}

#[tauri::command]
fn delete_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let mut config = load_config(&app).ok_or("No config")?;
    config.profiles.get_or_insert_with(HashMap::new).remove(&profile_name);
    if config.active_profile.as_deref() == Some(&profile_name) {
        config.active_profile = None;
    }
    save_config_inner(&app, &config)
}

#[tauri::command]
fn export_profile(app: AppHandle, profile_name: String, export_path: String) -> Result<(), String> {
    let config = load_config(&app).ok_or("No config")?;
    let profiles = config.profiles.unwrap_or_default();
    let mods = profiles.get(&profile_name).cloned().unwrap_or_default();
    let data = serde_json::json!({ "profile": profile_name, "mods": mods });
    fs::write(&export_path, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn import_profile(app: AppHandle, import_path: String) -> Result<String, String> {
    let raw = fs::read_to_string(&import_path).map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let profile_name = data["profile"].as_str().ok_or("Invalid profile file")?.to_string();
    let mods: Vec<String> = data["mods"].as_array()
        .ok_or("Invalid profile file")?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let mut config = load_config(&app).ok_or("No config")?;
    config.profiles.get_or_insert_with(HashMap::new).insert(profile_name.clone(), mods);
    save_config_inner(&app, &config)?;
    Ok(profile_name)
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(NxmQueue::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            app.deep_link().register("nxm").ok();

            let handle = app.handle().clone();

            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let url_str = url.to_string();
                    if url_str.starts_with("nxm://") {
                        let h = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = process_nxm(&h, url_str).await {
                                let _ = h.emit("nxm-error", e);
                            }
                        });
                    }
                }
            });

            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Ok(mut q) = app.state::<NxmQueue>().0.lock() {
                    for url in urls {
                        let s = url.to_string();
                        if s.starts_with("nxm://") { q.push(s); }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            validate_folder,
            scan_mods,
            toggle_mod,
            uninstall_mod,
            install_from_zip,
            peek_zip_name,
            handle_nxm,
            get_pending_nxm,
            switch_profile,
            save_profile,
            delete_profile,
            export_profile,
            import_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error running Tidekeeper");
}
