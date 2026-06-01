use reqwest::Client;
use tauri_plugin_updater::UpdaterExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub mods_folder: Option<String>,
    pub setup_complete: Option<bool>,
    pub nexus_client_id: Option<String>,
    pub nexus_token: Option<String>,
    pub nexus_refresh_token: Option<String>,
    pub nexus_token_expiry: Option<u64>,
    pub nexus_username: Option<String>,
    pub nexus_is_premium: Option<bool>,
    pub nexus_api_key: Option<String>,
    pub profiles: Option<HashMap<String, Vec<String>>>,
    pub active_profile: Option<String>,
    pub download_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModMeta {
    pub source: String,          // "nexus" | "manual"
    pub mod_id: Option<u64>,
    pub file_id: Option<u64>,
    pub version: Option<String>,
    pub display_name: Option<String>,
    pub file_name: Option<String>,
    pub installed_at: u64,
    pub installed_files: Option<Vec<String>>,
    pub backup_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    pub name: String,
    pub enabled: bool,
    pub path: String,
    pub mod_type: String, // "script" | "pak"
    pub meta: Option<ModMeta>,
    pub config_files: Vec<String>,
    pub has_backup: bool,
}

// Returned by peek_zip_name so the UI knows whether to show the name prompt
// and what hint to display.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZipInfo {
    pub suggested_name: String,
    pub install_type: String,  // "game_relative" | "pak" | "script"
    pub needs_name_prompt: bool,
    pub nexus_mod_id: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagIssue {
    pub severity: String, // "error" | "warning" | "ok"
    pub title: String,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub ts: u64,
    pub level: String, // "INFO" | "WARN" | "ERROR"
    pub message: String,
}

#[derive(Deserialize)]
struct DownloadLink {
    #[serde(rename = "URI")]
    uri: String,
}


#[derive(Default)]
struct NxmQueue(Mutex<Vec<String>>);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn meta_path(mod_path: &Path) -> PathBuf { mod_path.join("tidekeeper.json") }

fn read_meta(mod_path: &Path) -> Option<ModMeta> {
    fs::read_to_string(meta_path(mod_path)).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn write_meta(mod_path: &Path, meta: &ModMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(meta_path(mod_path), json).map_err(|e| e.to_string())
}

fn mod_install_path(install_type: &str, mods_folder: &str, mod_name: &str) -> Option<PathBuf> {
    match install_type {
        "pak" => derive_inner_game_folder(mods_folder).ok()
            .map(|inner| inner.join("Content").join("Paks").join("LogicMods").join(mod_name)),
        "ue4ss" => None,
        _ => Some(PathBuf::from(mods_folder).join(mod_name)),
    }
}

fn log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("tidekeeper.log")
}

fn write_log(app: &AppHandle, level: &str, message: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let line = format!("{}|{}|{}\n", ts, level, message);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path(app)) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

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
fn collect_mod_files(mod_path: &Path) -> Vec<String> {
    let mut files = Vec::new();
    fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() { walk(&p, base, out); }
            else if let Ok(rel) = p.strip_prefix(base) {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
    walk(mod_path, mod_path, &mut files);
    files
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub mod_path: String,
    pub ok: bool,
    pub missing: Vec<String>,
}

#[tauri::command]
fn verify_mod(mod_path: String) -> VerifyResult {
    let path = PathBuf::from(&mod_path);
    let meta = match read_meta(&path) {
        Some(m) => m,
        None => return VerifyResult { mod_path, ok: true, missing: vec![] },
    };
    let Some(files) = meta.installed_files else {
        return VerifyResult { mod_path, ok: true, missing: vec![] };
    };
    let missing: Vec<String> = files.into_iter()
        .filter(|f| {
            let p = path.join(f);
            f != "tidekeeper.json" && !p.exists()
        })
        .collect();
    let ok = missing.is_empty();
    VerifyResult { mod_path, ok, missing }
}

#[tauri::command]
fn rollback_mod(mod_path: String) -> Result<(), String> {
    let path = PathBuf::from(&mod_path);
    let meta = read_meta(&path).ok_or("No metadata found for this mod")?;
    let backup_path = meta.backup_path.ok_or("No backup available for this mod")?;
    let backup = PathBuf::from(&backup_path);
    if !backup.exists() {
        return Err("Backup folder no longer exists".into());
    }
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&backup, &path).map_err(|e| e.to_string())?;
    Ok(())
}

fn find_config_files(mod_path: &Path) -> Vec<String> {
    const CONFIG_EXTS: &[&str] = &["ini", "cfg", "toml"];
    const CONFIG_NAMES: &[&str] = &["config.json", "settings.json", "options.json"];
    let mut found = Vec::new();

    let Ok(entries) = fs::read_dir(mod_path) else { return found; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_lowercase();
            if dir_name == "config" {
                // Config/ subfolder — any common config extension
                if let Ok(sub) = fs::read_dir(&path) {
                    for sub_entry in sub.flatten() {
                        let sp = sub_entry.path();
                        if sp.is_file() && matches_config(&sp) {
                            found.push(sp.to_string_lossy().into_owned());
                        }
                    }
                }
            } else if dir_name == "scripts" {
                // Scripts/ subfolder — files named config.* or config.*.new (UE4SS convention)
                if let Ok(sub) = fs::read_dir(&path) {
                    for sub_entry in sub.flatten() {
                        let sp = sub_entry.path();
                        if sp.is_file() {
                            let fname = sp.file_name().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                            let stem = sp.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                            if stem == "config" || fname.starts_with("config.") {
                                found.push(sp.to_string_lossy().into_owned());
                            }
                        }
                    }
                }
            }
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name == "tidekeeper.json" || name == "enabled.txt" { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if CONFIG_EXTS.contains(&ext.as_str()) || CONFIG_NAMES.contains(&name.as_str()) {
            found.push(path.to_string_lossy().into_owned());
        }
    }
    found
}

fn matches_config(path: &Path) -> bool {
    const EXTS: &[&str] = &["ini", "cfg", "toml", "json"];
    path.extension().and_then(|e| e.to_str()).map(|e| EXTS.contains(&e.to_lowercase().as_str())).unwrap_or(false)
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
            let meta = read_meta(&path);
            let has_backup = meta.as_ref()
                .and_then(|m| m.backup_path.as_deref())
                .map(|bp| PathBuf::from(bp).exists())
                .unwrap_or(false);
            mods.push(ModEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                enabled: path.join("enabled.txt").exists(),
                meta,
                config_files: find_config_files(&path),
                path: path.to_string_lossy().into_owned(),
                mod_type: "script".into(),
                has_backup,
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
                let meta = read_meta(&path);
                let has_backup = meta.as_ref()
                    .and_then(|m| m.backup_path.as_deref())
                    .map(|bp| PathBuf::from(bp).exists())
                    .unwrap_or(false);
                mods.push(ModEntry {
                    name,
                    enabled,
                    meta,
                    config_files: find_config_files(&path),
                    path: path.to_string_lossy().into_owned(),
                    mod_type: "pak".into(),
                    has_backup,
                });
            }
        }
    }

    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(mods)
}

#[tauri::command]
fn toggle_mod(app: AppHandle, mod_path: String, enabled: bool) -> Result<String, String> {
    let path = PathBuf::from(&mod_path);
    let parent = path.parent().ok_or("Invalid mod path")?;
    let name = path.file_name().ok_or("Invalid mod path")?.to_string_lossy().into_owned();

    // Pak mod: identified by living inside a LogicMods folder
    let is_pak = parent.file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("logicmods"))
        .unwrap_or(false)
        || name.ends_with(".disabled");

    let result = if is_pak {
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
    };

    let display = name.trim_end_matches(".disabled");
    write_log(&app, "INFO", &format!("{}: {}", if enabled { "Enabled" } else { "Disabled" }, display));
    result
}

#[tauri::command]
fn uninstall_mod(app: AppHandle, mod_path: String) -> Result<(), String> {
    let mod_name = PathBuf::from(&mod_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    fs::remove_dir_all(&mod_path).map_err(|e| e.to_string())?;
    write_log(&app, "INFO", &format!("Uninstalled: {}", mod_name));

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

// ── Archive extraction ────────────────────────────────────────────────────────

fn archive_to_zip_bytes(path: &str) -> Result<Vec<u8>, String> {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "zip" => fs::read(path).map_err(|e| e.to_string()),
        "7z"  => sevenz_to_zip_bytes(path),
        "rar" => rar_to_zip_bytes(path),
        _     => Err(format!("Unsupported format: .{}", ext)),
    }
}

fn make_temp_dir() -> Result<PathBuf, String> {
    let tmp = std::env::temp_dir().join(format!("tk_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    Ok(tmp)
}

fn dir_to_zip_bytes(dir: &PathBuf) -> Result<Vec<u8>, String> {
    use std::io::Write;
    fn add(zw: &mut zip::ZipWriter<io::Cursor<Vec<u8>>>, base: &PathBuf, cur: &PathBuf, opts: zip::write::SimpleFileOptions) -> Result<(), String> {
        for e in fs::read_dir(cur).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let p = e.path();
            let rel = p.strip_prefix(base).map_err(|e| e.to_string())?;
            let name = rel.to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                zw.add_directory(format!("{}/", name), opts).map_err(|e| e.to_string())?;
                add(zw, base, &p, opts)?;
            } else {
                zw.start_file(&name, opts).map_err(|e| e.to_string())?;
                zw.write_all(&fs::read(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    let mut zw = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    add(&mut zw, dir, dir, opts)?;
    Ok(zw.finish().map_err(|e| e.to_string())?.into_inner())
}

fn sevenz_to_zip_bytes(path: &str) -> Result<Vec<u8>, String> {
    let tmp = make_temp_dir()?;
    sevenz_rust::decompress_file(path, &tmp).map_err(|e| e.to_string())?;
    let result = dir_to_zip_bytes(&tmp);
    fs::remove_dir_all(&tmp).ok();
    result
}

fn find_7zip() -> Option<PathBuf> {
    [r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"]
        .iter().map(PathBuf::from).find(|p| p.exists())
}

fn rar_to_zip_bytes(path: &str) -> Result<Vec<u8>, String> {
    let exe = find_7zip().ok_or(
        "RAR files require 7-Zip. Download it from 7-zip.org and install it, then try again."
    )?;
    let tmp = make_temp_dir()?;
    let status = std::process::Command::new(&exe)
        .args(["x", path, &format!("-o{}", tmp.display()), "-y"])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        fs::remove_dir_all(&tmp).ok();
        return Err("7-Zip failed to extract the RAR file".into());
    }
    let result = dir_to_zip_bytes(&tmp);
    fs::remove_dir_all(&tmp).ok();
    result
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

// Nexus download filenames: {file-name}-{modId}-{version}-{timestamp}
// The modId is the first all-numeric hyphen-separated segment.
fn extract_nexus_mod_id(zip_stem: &str) -> Option<u64> {
    zip_stem.split('-')
        .find(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .and_then(|s| s.parse().ok())
}

fn analyze_zip(data: &[u8], zip_stem: &str) -> Result<ZipInfo, String> {
    let cursor = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let mut first_root: Option<String> = None;
    let mut has_pak = false;
    let mut first_pak_stem: Option<String> = None;
    let mut embedded_mod_name: Option<String> = None;
    let mut is_ue4ss = false;

    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            let fname = file.name();
            let fname_lower = fname.to_lowercase().replace('\\', "/");

            if fname_lower == "ue4ss/ue4ss.dll" {
                is_ue4ss = true;
            }

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

    let nexus_mod_id = extract_nexus_mod_id(zip_stem);

    if is_ue4ss {
        return Ok(ZipInfo {
            suggested_name: "UE4SS".into(),
            install_type: "ue4ss".into(),
            needs_name_prompt: false,
            nexus_mod_id: None,
        });
    }

    let root_lower = first_root.as_deref().unwrap_or("").to_lowercase();

    if root_lower == "subnautica2" {
        Ok(ZipInfo {
            suggested_name: embedded_mod_name.unwrap_or_else(|| zip_stem.to_string()),
            install_type: "game_relative".into(),
            needs_name_prompt: false,
            nexus_mod_id,
        })
    } else if root_lower == "logicmods" {
        let found = first_pak_stem.is_some();
        Ok(ZipInfo {
            suggested_name: first_pak_stem.unwrap_or_else(|| zip_stem.to_string()),
            install_type: "pak".into(),
            needs_name_prompt: !found,
            nexus_mod_id,
        })
    } else if has_pak {
        Ok(ZipInfo {
            suggested_name: first_root.clone().unwrap_or_else(|| zip_stem.to_string()),
            install_type: "pak".into(),
            needs_name_prompt: first_root.is_none(),
            nexus_mod_id,
        })
    } else {
        Ok(ZipInfo {
            suggested_name: first_root.clone().unwrap_or_else(|| zip_stem.to_string()),
            install_type: "script".into(),
            needs_name_prompt: first_root.is_none(),
            nexus_mod_id,
        })
    }
}

// Extract all ZIP entries as-is to `base` with no component stripping.
// Used for UE4SS which ships with files at the ZIP root (no top-level folder).
fn extract_flat(data: Vec<u8>, base: &PathBuf) -> Result<(), String> {
    let cursor = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = PathBuf::from(file.name());
        if raw.components().any(|c| c.as_os_str() == "..") { continue; }
        let out = base.join(&raw);
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
        "ue4ss" => {
            let inner = derive_inner_game_folder(mods_folder)?;
            let win64 = inner.join("Binaries").join("Win64");
            extract_flat(data, &win64)?;
            Ok("UE4SS".into())
        }
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
async fn peek_zip_name(app: AppHandle, zip_path: String) -> Result<ZipInfo, String> {
    let data = archive_to_zip_bytes(&zip_path)?;
    let zip_stem = PathBuf::from(&zip_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());
    let mut info = analyze_zip(&data, &zip_stem)?;

    // If we detected a Nexus mod ID, resolve the display name from the API
    if let Some(mod_id) = info.nexus_mod_id {
        if let Ok((auth_header, auth_value)) = get_nexus_auth(&app).await {
            let client = Client::new();
            let url = format!("https://api.nexusmods.com/v1/games/subnautica2/mods/{}.json", mod_id);
            if let Ok(resp) = client.get(&url)
                .header(auth_header.as_str(), auth_value.as_str())
                .header("Application-Name", "Tidekeeper")
                .header("Application-Version", "0.5.1")
                .send().await
            {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
                        info.suggested_name = name.to_string();
                        info.needs_name_prompt = false;
                    }
                }
            }
        }
    }

    Ok(info)
}

#[tauri::command]
fn install_from_zip(app: AppHandle, zip_path: String, mod_name: String) -> Result<String, String> {
    let config = load_config(&app).ok_or("No config found")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let data = archive_to_zip_bytes(&zip_path)?;
    let zip_stem = PathBuf::from(&zip_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());
    let zip_info = analyze_zip(&data, &zip_stem).ok();
    let install_type = zip_info.as_ref().map(|i| i.install_type.clone()).unwrap_or_default();
    let nexus_mod_id = zip_info.and_then(|i| i.nexus_mod_id);
    match install_zip_bytes(data, &mods_folder, &zip_stem, mod_name.trim()) {
        Ok(name) => {
            write_log(&app, "INFO", &format!("Installed: {}", name));
            if let Some(mod_path) = mod_install_path(&install_type, &mods_folder, &name) {
                let files = collect_mod_files(&mod_path);
                let meta = if let Some(mid) = nexus_mod_id {
                    ModMeta { source: "nexus".into(), mod_id: Some(mid), installed_at: now_secs(), installed_files: Some(files), ..Default::default() }
                } else {
                    ModMeta { source: "manual".into(), installed_at: now_secs(), installed_files: Some(files), ..Default::default() }
                };
                write_meta(&mod_path, &meta).ok();
            }
            Ok(name)
        }
        Err(e) => {
            write_log(&app, "ERROR", &format!("Install failed for {}: {}", mod_name, e));
            Err(e)
        }
    }
}

// ── Game launcher ────────────────────────────────────────────────────────────

#[tauri::command]
fn launch_game(app: AppHandle) -> Result<(), String> {
    let config = load_config(&app).ok_or("No config found")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let inner = derive_inner_game_folder(&mods_folder)?;
    let exe = inner.join("Binaries").join("Win64").join("Subnautica2-Win64-Shipping.exe");
    if !exe.exists() {
        return Err(format!("Executable not found: {}", exe.display()));
    }
    std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap())
        .spawn()
        .map_err(|e| {
            write_log(&app, "ERROR", &format!("Failed to launch game: {}", e));
            e.to_string()
        })?;
    write_log(&app, "INFO", "Game launched");
    Ok(())
}

// ── UE4SS management ─────────────────────────────────────────────────────────

#[tauri::command]
fn check_ue4ss(app: AppHandle) -> bool {
    let Some(config) = load_config(&app) else { return false; };
    let Some(mods_folder) = config.mods_folder else { return false; };
    let Ok(inner) = derive_inner_game_folder(&mods_folder) else { return false; };
    inner.join("Binaries").join("Win64").join("ue4ss").join("UE4SS.dll").exists()
}

// ── Game detection ────────────────────────────────────────────────────────────

// Searches Steam libraries for the Subnautica 2 install folder.
// Returns the path to steamapps/common/Subnautica2 if found.
#[cfg(windows)]
fn find_subnautica2_install() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let steam_path: String = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam").ok()?
        .get_value("SteamPath").ok()?;
    let steam_root = PathBuf::from(steam_path.replace('/', "\\"));

    let check = |lib: &PathBuf| -> Option<String> {
        let game = lib.join("steamapps").join("common").join("Subnautica2");
        if game.is_dir() { Some(game.to_string_lossy().into_owned()) } else { None }
    };

    if let Some(p) = check(&steam_root) { return Some(p); }

    // Check additional libraries listed in libraryfolders.vdf
    let vdf = fs::read_to_string(
        steam_root.join("steamapps").join("libraryfolders.vdf")
    ).ok()?;

    for line in vdf.lines() {
        // VDF lines look like:  "path"   "F:\\SteamLibrary"
        let tokens: Vec<&str> = line.trim().split('"').collect();
        if let Some(&raw) = tokens.get(3) {
            if raw.contains(":\\") || raw.starts_with('/') {
                let lib = PathBuf::from(raw.replace("\\\\", "\\"));
                if let Some(p) = check(&lib) { return Some(p); }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn find_subnautica2_install() -> Option<String> { None }

#[tauri::command]
fn find_subnautica2() -> Option<String> {
    find_subnautica2_install()
}

// Creates the UE4SS/Mods folder structure inside the given game folder and
// returns the mods folder path. Accepts either the Steam install folder
// (steamapps/common/Subnautica2) or the inner game folder directly.
#[tauri::command]
fn create_mod_structure(game_folder: String) -> Result<String, String> {
    let base = PathBuf::from(&game_folder);

    // Handle both folder levels users might select:
    //   Steam install: steamapps/common/Subnautica2  → inner is base/Subnautica2
    //   Inner folder:  .../Subnautica2/Subnautica2   → inner is base itself
    let inner = if base.join("Subnautica2").join("Binaries").is_dir() {
        base.join("Subnautica2")
    } else if base.join("Binaries").is_dir() {
        base.clone()
    } else {
        return Err(
            "Subnautica 2 game files not found here. \
             Select the folder named Subnautica2 inside your Steam library.".into()
        );
    };

    let mods_path = inner
        .join("Binaries").join("Win64")
        .join("ue4ss").join("Mods");
    fs::create_dir_all(&mods_path).map_err(|e| format!("Could not create mods folder: {}", e))?;
    Ok(mods_path.to_string_lossy().into_owned())
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
    let mods_folder = config.mods_folder.clone().ok_or("No mods folder configured")?;
    let (auth_header, auth_value) = get_nexus_auth(app).await?;

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
        .header(auth_header.as_str(), auth_value.as_str())
        .header("Application-Name", "Tidekeeper")
        .header("Application-Version", "0.4.0")
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

    let saved_path = download_dir.join(&filename);
    fs::write(&saved_path, &bytes).map_err(|e| e.to_string())?;

    let zip_stem = PathBuf::from(&filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());

    // Convert to ZIP bytes (handles .zip, .7z, .rar)
    let zip_bytes = archive_to_zip_bytes(&saved_path.to_string_lossy())?;
    let info = analyze_zip(&zip_bytes, &zip_stem)?;

    // Extract clean variant name from download filename: "gravestone-waypoint-lite-1234-1-0-…" → "gravestone-waypoint-lite"
    let file_name_clean: Option<String> = info.nexus_mod_id.and_then(|mid| {
        let prefix = format!("-{}-", mid);
        zip_stem.split_once(&prefix).map(|(before, _)| before.to_string())
    });
    let folder_name = file_name_clean.as_deref().unwrap_or(&info.suggested_name);

    // --- Update / backup logic ---
    let expected_mod_path = mod_install_path(&info.install_type, &mods_folder, folder_name);
    let is_update = expected_mod_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let mut backup_path_str: Option<String> = None;
    let mut old_config_rel: Vec<String> = vec![];

    if is_update {
        if let Some(ref old_path) = expected_mod_path {
            let old_meta = read_meta(old_path);
            let old_version = old_meta.as_ref()
                .and_then(|m| m.version.as_deref())
                .unwrap_or("unknown")
                .replace(['/', '\\', ':'], "_");
            let folder_stem = old_path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "mod".into());
            let backup_name = format!("{}_{}", folder_stem, old_version);
            let backup_dir = app.path().app_data_dir().expect("app data dir")
                .join("backups").join(&backup_name);
            if backup_dir.exists() { let _ = fs::remove_dir_all(&backup_dir); }
            copy_dir_all(old_path, &backup_dir).map_err(|e| e.to_string())?;
            backup_path_str = Some(backup_dir.to_string_lossy().into_owned());

            // Remember relative paths of old config files so we can restore them
            old_config_rel = find_config_files(old_path)
                .into_iter()
                .filter_map(|abs| {
                    PathBuf::from(&abs).strip_prefix(old_path).ok()
                        .map(|rel| rel.to_string_lossy().into_owned())
                })
                .collect();

            // Remove old folder for a clean install
            fs::remove_dir_all(old_path).map_err(|e| e.to_string())?;
        }
    }
    // --- end backup logic ---

    let installed = install_zip_bytes(zip_bytes, &mods_folder, &zip_stem, folder_name)?;

    // Write nexus source metadata
    let mod_id_u64: Option<u64> = mod_id.parse().ok();
    let file_id_u64: Option<u64> = file_id.parse().ok();

    // Fetch mod display name and file variant name/version from Nexus
    let mut display_name: Option<String> = None;
    let mut file_variant_name: Option<String> = None;
    let mut file_version: Option<String> = None;

    if let (Some(mid), Some(fid)) = (mod_id_u64, file_id_u64) {
        let mod_url  = format!("https://api.nexusmods.com/v1/games/subnautica2/mods/{}.json", mid);
        let file_url = format!("https://api.nexusmods.com/v1/games/subnautica2/mods/{}/files/{}.json", mid, fid);

        if let Ok(resp) = client.get(&mod_url)
            .header(auth_header.as_str(), auth_value.as_str())
            .header("Application-Name", "Tidekeeper")
            .header("Application-Version", "0.5.1")
            .send().await
        {
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                display_name = j.get("name").and_then(|v| v.as_str()).map(str::to_string);
            }
        }

        if let Ok(resp) = client.get(&file_url)
            .header(auth_header.as_str(), auth_value.as_str())
            .header("Application-Name", "Tidekeeper")
            .header("Application-Version", "0.5.1")
            .send().await
        {
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                file_variant_name = j.get("name").and_then(|v| v.as_str()).map(str::to_string);
                file_version      = j.get("version").and_then(|v| v.as_str()).map(str::to_string);
            }
        }
    }

    if let Some(mod_path) = mod_install_path(&info.install_type, &mods_folder, &installed) {
        // Restore config files from backup: save new defaults as config.lua.new, put old settings back
        if is_update {
            if let Some(ref bp) = backup_path_str {
                let backup_dir = PathBuf::from(bp);
                for rel in &old_config_rel {
                    let new_cfg = mod_path.join(Path::new(rel.as_str()));
                    let old_cfg = backup_dir.join(Path::new(rel.as_str()));
                    if new_cfg.exists() && old_cfg.exists() {
                        // Save new defaults alongside as config.lua.new
                        let mut new_name = new_cfg.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        new_name.push_str(".new");
                        if let Some(parent) = new_cfg.parent() {
                            let _ = fs::copy(&new_cfg, parent.join(&new_name));
                        }
                        // Restore old config as active
                        let _ = fs::copy(&old_cfg, &new_cfg);
                    }
                }
            }
        }

        let meta = ModMeta {
            source: "nexus".into(),
            mod_id: mod_id_u64,
            file_id: file_id_u64,
            version: file_version,
            display_name,
            file_name: file_variant_name.or(file_name_clean),
            installed_at: now_secs(),
            installed_files: Some(collect_mod_files(&mod_path)),
            backup_path: backup_path_str,
        };
        write_meta(&mod_path, &meta).ok();
    }

    let _ = app.emit("nxm-installed", &installed);
    write_log(app, "INFO", &format!("NXM installed: {}", installed));
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

// ── Nexus user info ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusUserInfo {
    pub is_premium: bool,
    pub username: String,
}

#[tauri::command]
async fn validate_nexus_key(app: AppHandle) -> Result<NexusUserInfo, String> {
    let config = load_config(&app).ok_or("No config")?;
    let api_key = config.nexus_api_key.ok_or("No API key configured")?;
    let client = Client::new();
    let resp: serde_json::Value = client
        .get("https://api.nexusmods.com/v1/users/validate.json")
        .header("apikey", &api_key)
        .header("Application-Name", "Tidekeeper")
        .header("Application-Version", "0.4.0")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    Ok(NexusUserInfo {
        is_premium: resp["is_premium"].as_bool().unwrap_or(false),
        username: resp["name"].as_str().unwrap_or("").to_string(),
    })
}

// ── Nexus mod install (Discover tab) ─────────────────────────────────────────

#[derive(Deserialize)]
struct NexusFilesResponse {
    files: Vec<NexusApiFile>,
}

#[derive(Deserialize)]
struct NexusApiFile {
    file_id: u64,
    name: Option<String>,
    version: Option<String>,
    size_kb: Option<u64>,
    category_id: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusFileEntry {
    pub file_id: u64,
    pub name: String,
    pub version: Option<String>,
    pub size_kb: Option<u64>,
}

#[derive(Deserialize)]
struct NexusModInfo {
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModUpdateStatus {
    pub mod_name: String,
    pub mod_path: String,
    pub has_update: bool,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub mod_id: Option<u64>,
    pub latest_file_id: Option<u64>,
    pub latest_file_name: Option<String>,
}

#[tauri::command]
async fn get_nexus_mod_files(app: AppHandle, mod_id: u64) -> Result<Vec<NexusFileEntry>, String> {
    let (auth_header, auth_value) = get_nexus_auth(&app).await?;
    let client = Client::new();
    let url = format!("https://api.nexusmods.com/v1/games/subnautica2/mods/{}/files.json", mod_id);
    let resp: NexusFilesResponse = client
        .get(&url)
        .header(auth_header.as_str(), auth_value.as_str())
        .header("Application-Name", "Tidekeeper")
        .header("Application-Version", "0.4.0")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| format!("Failed to parse files: {}", e))?;
    // Only show MAIN (1) and OPTIONAL (3) — exclude old versions and deleted
    let entries = resp.files.into_iter()
        .filter(|f| matches!(f.category_id, Some(1) | Some(3)))
        .map(|f| NexusFileEntry {
            file_id: f.file_id,
            name: f.name.unwrap_or_else(|| format!("File {}", f.file_id)),
            version: f.version,
            size_kb: f.size_kb,
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
async fn install_nexus_mod(app: AppHandle, mod_id: u64, file_id: u64, version: Option<String>, file_name: Option<String>) -> Result<String, String> {
    let config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let (auth_header, auth_value) = get_nexus_auth(&app).await?;
    let download_dir = config.download_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_data_dir().expect("app data dir").join("downloads"));
    fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;

    let client = Client::new();
    let links_url = format!(
        "https://api.nexusmods.com/v1/games/subnautica2/mods/{}/files/{}/download_link.json",
        mod_id, file_id
    );
    let links_resp = client
        .get(&links_url)
        .header(auth_header.as_str(), auth_value.as_str())
        .header("Application-Name", "Tidekeeper")
        .header("Application-Version", "0.4.0")
        .send().await.map_err(|e| e.to_string())?;
    if !links_resp.status().is_success() {
        let body: serde_json::Value = links_resp.json().await.unwrap_or_default();
        let msg = body["message"].as_str().unwrap_or("unknown error");
        return Err(format!(
            "Nexus requires a Premium account for direct installs ({}). \
             Use the \"Mod Manager Download\" button on the Nexus website instead.",
            msg
        ));
    }
    let links: Vec<DownloadLink> = links_resp.json().await
        .map_err(|e| format!("Failed to parse download links: {}", e))?;
    let uri = links.into_iter().next().ok_or("No download links returned")?.uri;

    let filename = uri.split('/').last()
        .and_then(|s| s.split('?').next())
        .unwrap_or("mod.zip")
        .to_string();
    let bytes = client.get(&uri).send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;
    let saved_path = download_dir.join(&filename);
    fs::write(&saved_path, &bytes).map_err(|e| e.to_string())?;

    let zip_stem = PathBuf::from(&filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod".into());
    let zip_bytes = archive_to_zip_bytes(&saved_path.to_string_lossy())?;
    let info = analyze_zip(&zip_bytes, &zip_stem)?;
    let folder_name = file_name.as_deref().unwrap_or(&info.suggested_name);

    // Backup existing install if this is an update
    let expected_mod_path = mod_install_path(&info.install_type, &mods_folder, folder_name);
    let is_update = expected_mod_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let mut backup_path_str: Option<String> = None;
    let mut old_config_rel: Vec<String> = vec![];

    if is_update {
        if let Some(ref old_path) = expected_mod_path {
            let old_meta = read_meta(old_path);
            let old_version = old_meta.as_ref()
                .and_then(|m| m.version.as_deref())
                .unwrap_or("unknown")
                .replace(['/', '\\', ':'], "_");
            let folder_stem = old_path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "mod".into());
            let backup_name = format!("{}_{}", folder_stem, old_version);
            let backup_dir = app.path().app_data_dir().expect("app data dir")
                .join("backups").join(&backup_name);
            if backup_dir.exists() { let _ = fs::remove_dir_all(&backup_dir); }
            copy_dir_all(old_path, &backup_dir).map_err(|e| e.to_string())?;
            backup_path_str = Some(backup_dir.to_string_lossy().into_owned());
            old_config_rel = find_config_files(old_path)
                .into_iter()
                .filter_map(|abs| {
                    PathBuf::from(&abs).strip_prefix(old_path).ok()
                        .map(|rel| rel.to_string_lossy().into_owned())
                })
                .collect();
            fs::remove_dir_all(old_path).map_err(|e| e.to_string())?;
        }
    }

    let installed = install_zip_bytes(zip_bytes, &mods_folder, &zip_stem, folder_name)?;

    if let Some(mod_path) = mod_install_path(&info.install_type, &mods_folder, &installed) {
        if is_update {
            if let Some(ref bp) = backup_path_str {
                let backup_dir = PathBuf::from(bp);
                for rel in &old_config_rel {
                    let new_cfg = mod_path.join(Path::new(rel.as_str()));
                    let old_cfg = backup_dir.join(Path::new(rel.as_str()));
                    if new_cfg.exists() && old_cfg.exists() {
                        let mut new_name = new_cfg.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        new_name.push_str(".new");
                        if let Some(parent) = new_cfg.parent() {
                            let _ = fs::copy(&new_cfg, parent.join(&new_name));
                        }
                        let _ = fs::copy(&old_cfg, &new_cfg);
                    }
                }
            }
        }
        let meta = ModMeta {
            source: "nexus".into(),
            mod_id: Some(mod_id),
            file_id: Some(file_id),
            version: version.clone(),
            display_name: None,
            file_name,
            installed_at: now_secs(),
            installed_files: Some(collect_mod_files(&mod_path)),
            backup_path: backup_path_str,
        };
        write_meta(&mod_path, &meta).ok();
    }

    write_log(&app, "INFO", &format!("Nexus install: {} (mod {}, file {})", installed, mod_id, file_id));
    Ok(installed)
}

#[tauri::command]
async fn check_mod_updates(app: AppHandle) -> Vec<ModUpdateStatus> {
    let Some(config) = load_config(&app) else { return vec![]; };
    let Some(mods_folder) = config.mods_folder.clone() else { return vec![]; };
    let (auth_header, auth_value) = match get_nexus_auth(&app).await {
        Ok(a)  => a,
        Err(_) => return vec![],
    };

    let mut nexus_mods: Vec<(String, PathBuf, ModMeta)> = Vec::new();

    let script_dir = PathBuf::from(&mods_folder);
    if script_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&script_dir) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(meta) = read_meta(&path) {
                    if meta.source == "nexus" && meta.mod_id.is_some() {
                        nexus_mods.push((name, path, meta));
                    }
                }
            }
        }
    }
    if let Ok(inner) = derive_inner_game_folder(&mods_folder) {
        let pak_dir = inner.join("Content").join("Paks").join("LogicMods");
        if pak_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&pak_dir) {
                for entry in entries.flatten() {
                    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                    let path = entry.path();
                    let raw = entry.file_name().to_string_lossy().into_owned();
                    let name = raw.trim_end_matches(".disabled").to_string();
                    if let Some(meta) = read_meta(&path) {
                        if meta.source == "nexus" && meta.mod_id.is_some() {
                            nexus_mods.push((name, path, meta));
                        }
                    }
                }
            }
        }
    }

    if nexus_mods.is_empty() { return vec![]; }

    let client = Client::new();
    let mut results = Vec::new();

    for (name, path, meta) in nexus_mods {
        let mod_id = meta.mod_id.unwrap();
        let url = format!("https://api.nexusmods.com/v1/games/subnautica2/mods/{}.json", mod_id);
        let latest_version: Option<String> = async {
            let r = client.get(&url)
                .header(auth_header.as_str(), auth_value.as_str())
                .header("Application-Name", "Tidekeeper")
                .header("Application-Version", "0.4.0")
                .send().await.ok()?;
            r.json::<NexusModInfo>().await.ok()?.version
        }.await;

        let has_update = match (&meta.version, &latest_version) {
            (Some(installed), Some(latest)) => installed != latest,
            _ => false,
        };

        // For mods with updates, find the matching latest file_id
        let (latest_file_id, latest_file_name) = if has_update {
            let files_url = format!("https://api.nexusmods.com/v1/games/subnautica2/mods/{}/files.json", mod_id);
            let files: Option<Vec<NexusApiFile>> = async {
                let r = client.get(&files_url)
                    .header(auth_header.as_str(), auth_value.as_str())
                    .header("Application-Name", "Tidekeeper")
                    .header("Application-Version", "0.5.4")
                    .send().await.ok()?;
                r.json::<NexusFilesResponse>().await.ok().map(|r| r.files)
            }.await;
            if let Some(files) = files {
                let main_files: Vec<_> = files.into_iter()
                    .filter(|f| f.category_id == Some(1))
                    .collect();
                // Try to match by installed file name, else pick first main file
                let matched = meta.file_name.as_deref().and_then(|installed_name| {
                    main_files.iter().find(|f| {
                        f.name.as_deref().map(|n| n.eq_ignore_ascii_case(installed_name)).unwrap_or(false)
                    })
                }).or_else(|| main_files.first());
                matched.map(|f| (Some(f.file_id), f.name.clone()))
                    .unwrap_or((None, None))
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        results.push(ModUpdateStatus {
            mod_name: name,
            mod_path: path.to_string_lossy().into_owned(),
            has_update,
            installed_version: meta.version,
            latest_version,
            mod_id: Some(mod_id),
            latest_file_id,
            latest_file_name,
        });
    }

    results
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

// ── Unmanaged mod adoption ────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmanagedGroup {
    pub suggested_name: String,
    pub files: Vec<String>,
}

#[tauri::command]
fn get_unmanaged_paks(app: AppHandle) -> Vec<UnmanagedGroup> {
    let Some(config) = load_config(&app) else { return vec![]; };
    let Some(mods_folder) = config.mods_folder else { return vec![]; };
    let Ok(inner) = derive_inner_game_folder(&mods_folder) else { return vec![]; };
    let pak_dir = inner.join("Content").join("Paks").join("LogicMods");
    if !pak_dir.is_dir() { return vec![]; }

    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(entries) = fs::read_dir(&pak_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            if lower.ends_with(".pak") || lower.ends_with(".utoc") || lower.ends_with(".ucas") {
                let stem = PathBuf::from(&name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| name.clone());
                groups.entry(stem).or_default().push(name);
            }
        }
    }

    groups.into_iter()
        .map(|(stem, files)| UnmanagedGroup { suggested_name: stem, files })
        .collect()
}

#[tauri::command]
fn adopt_unmanaged_pak(app: AppHandle, suggested_name: String, mod_name: String) -> Result<(), String> {
    let config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder")?;
    let inner = derive_inner_game_folder(&mods_folder)?;
    let pak_dir = inner.join("Content").join("Paks").join("LogicMods");
    let dest = pak_dir.join(mod_name.trim());
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    if let Ok(entries) = fs::read_dir(&pak_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            if !(lower.ends_with(".pak") || lower.ends_with(".utoc") || lower.ends_with(".ucas")) { continue; }
            let stem = PathBuf::from(&name)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if stem == suggested_name {
                fs::rename(&path, dest.join(&name)).map_err(|e| e.to_string())?;
            }
        }
    }

    write_log(&app, "INFO", &format!("Adopted unmanaged mod as: {}", mod_name.trim()));
    Ok(())
}

// ── Mod pack export / import ─────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModpackEntry {
    pub name: String,
    pub mod_type: String, // "pak" | "script"
    pub enabled: bool,
}

#[derive(Serialize, Deserialize)]
struct ModpackMeta {
    app: String,
    format_version: u32,
    mods: Vec<ModpackEntry>,
}

fn zip_dir(
    zw: &mut zip::ZipWriter<io::Cursor<Vec<u8>>>,
    src: &Path,
    prefix: &str,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    use std::io::Write;
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = entry.file_name().to_string_lossy().into_owned();
            let zip_path = format!("{}/{}", prefix, rel);
            if path.is_dir() {
                zw.add_directory(format!("{}/", zip_path), opts).map_err(|e| e.to_string())?;
                zip_dir(zw, &path, &zip_path, opts)?;
            } else {
                zw.start_file(&zip_path, opts).map_err(|e| e.to_string())?;
                zw.write_all(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn export_modpack(app: AppHandle, export_path: String) -> Result<u32, String> {
    use std::io::Write;
    let config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let Ok(inner) = derive_inner_game_folder(&mods_folder) else {
        return Err("Invalid mods folder path".into());
    };
    let script_dir = PathBuf::from(&mods_folder);
    let pak_dir = inner.join("Content").join("Paks").join("LogicMods");

    let mut entries: Vec<ModpackEntry> = Vec::new();

    if script_dir.is_dir() {
        for entry in fs::read_dir(&script_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let enabled = path.join("enabled.txt").exists();
            entries.push(ModpackEntry { name, mod_type: "script".into(), enabled });
        }
    }

    if pak_dir.is_dir() {
        for entry in fs::read_dir(&pak_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let raw = entry.file_name().to_string_lossy().into_owned();
            let (name, enabled) = if raw.ends_with(".disabled") {
                (raw.trim_end_matches(".disabled").to_string(), false)
            } else {
                (raw, true)
            };
            entries.push(ModpackEntry { name, mod_type: "pak".into(), enabled });
        }
    }

    if entries.is_empty() {
        return Err("No mods installed to export".into());
    }

    let count = entries.len() as u32;
    let mut zw = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();

    let meta = ModpackMeta { app: "tidekeeper".into(), format_version: 1, mods: entries.clone() };
    zw.start_file("modpack.json", opts).map_err(|e| e.to_string())?;
    zw.write_all(serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    for entry in &entries {
        let src_dir = match entry.mod_type.as_str() {
            "pak" => {
                let ep = pak_dir.join(&entry.name);
                let dp = pak_dir.join(format!("{}.disabled", entry.name));
                if ep.is_dir() { ep } else { dp }
            }
            _ => script_dir.join(&entry.name),
        };
        if !src_dir.is_dir() { continue; }
        zw.add_directory(format!("{}/{}/", entry.mod_type, entry.name), opts).map_err(|e| e.to_string())?;
        zip_dir(&mut zw, &src_dir, &format!("{}/{}", entry.mod_type, entry.name), opts)?;
    }

    let bytes = zw.finish().map_err(|e| e.to_string())?.into_inner();
    fs::write(&export_path, bytes).map_err(|e| e.to_string())?;
    write_log(&app, "INFO", &format!("Exported mod pack: {} mods → {}", count, export_path));
    Ok(count)
}

#[tauri::command]
fn peek_modpack(archive_path: String) -> Result<Vec<ModpackEntry>, String> {
    let data = fs::read(&archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(io::Cursor::new(data)).map_err(|e| e.to_string())?;
    let mut manifest = archive.by_name("modpack.json")
        .map_err(|_| "Not a Tidekeeper mod pack (modpack.json not found)")?;
    let mut bytes = Vec::new();
    io::copy(&mut manifest, &mut bytes).map_err(|e| e.to_string())?;
    let meta: ModpackMeta = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(meta.mods)
}

#[tauri::command]
fn install_modpack(app: AppHandle, archive_path: String) -> Result<u32, String> {
    let config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let inner = derive_inner_game_folder(&mods_folder)?;
    let script_dir = PathBuf::from(&mods_folder);
    let pak_dir = inner.join("Content").join("Paks").join("LogicMods");

    let data = fs::read(&archive_path).map_err(|e| e.to_string())?;

    // Pass 1: read manifest
    let meta: ModpackMeta = {
        let mut archive = zip::ZipArchive::new(io::Cursor::new(data.as_slice())).map_err(|e| e.to_string())?;
        let mut f = archive.by_name("modpack.json")
            .map_err(|_| "Not a Tidekeeper mod pack (modpack.json not found)")?;
        let mut bytes = Vec::new();
        io::copy(&mut f, &mut bytes).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
    };

    // Pass 2: extract files
    let mut archive = zip::ZipArchive::new(io::Cursor::new(data.as_slice())).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let fname = file.name().to_string();
        if fname == "modpack.json" { continue; }

        let fpath = PathBuf::from(&fname);
        if fpath.components().any(|c| c.as_os_str() == "..") { continue; }

        let parts: Vec<_> = fpath.components().collect();
        if parts.len() < 2 { continue; }

        let type_prefix = parts[0].as_os_str().to_string_lossy();
        let base_dir = match type_prefix.as_ref() {
            "pak"    => &pak_dir,
            "script" => &script_dir,
            _        => continue,
        };

        let rel: PathBuf = parts[1..].iter().collect();
        let out = base_dir.join(&rel);

        if fname.ends_with('/') {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
            io::copy(&mut file, &mut f).map_err(|e| e.to_string())?;
        }
    }

    // Fix enabled/disabled state per manifest
    for entry in &meta.mods {
        match entry.mod_type.as_str() {
            "script" => {
                let ef = script_dir.join(&entry.name).join("enabled.txt");
                if entry.enabled { let _ = fs::write(&ef, ""); }
                else if ef.exists() { let _ = fs::remove_file(&ef); }
            }
            "pak" => {
                let ep = pak_dir.join(&entry.name);
                let dp = pak_dir.join(format!("{}.disabled", entry.name));
                if !entry.enabled && ep.is_dir() { let _ = fs::rename(&ep, &dp); }
                else if entry.enabled && dp.is_dir() { let _ = fs::rename(&dp, &ep); }
            }
            _ => {}
        }
    }

    let count = meta.mods.len() as u32;
    write_log(&app, "INFO", &format!("Installed mod pack: {} mods from {}", count, archive_path));
    Ok(count)
}

// ── Log ───────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_log(app: AppHandle) -> Vec<LogLine> {
    let Ok(content) = fs::read_to_string(log_path(&app)) else { return vec![]; };
    let mut lines: Vec<LogLine> = content
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '|');
            let ts = parts.next()?.parse::<u64>().ok()?;
            let level = parts.next()?.to_string();
            let message = parts.next()?.to_string();
            Some(LogLine { ts, level, message })
        })
        .collect();
    lines.reverse();
    lines.truncate(500);
    lines
}

#[tauri::command]
fn clear_log(app: AppHandle) -> Result<(), String> {
    fs::write(log_path(&app), "").map_err(|e| e.to_string())
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

fn scan_hooks(dir: &PathBuf, mod_name: &str, map: &mut HashMap<String, Vec<String>>) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_hooks(&path, mod_name, map);
        } else if path.extension().map(|e| e.eq_ignore_ascii_case("lua")).unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(&path) {
                for line in content.lines() {
                    if let Some(idx) = line.find("RegisterHook(") {
                        if let Some(hook) = lua_string_arg(&line[idx + 13..]) {
                            map.entry(hook).or_default().push(mod_name.to_string());
                        }
                    }
                }
            }
        }
    }
}

fn lua_string_arg(s: &str) -> Option<String> {
    let s = s.trim_start();
    let (q, rest) = if s.starts_with('"') { ('"', &s[1..]) }
                    else if s.starts_with('\'') { ('\'', &s[1..]) }
                    else { return None; };
    rest.find(q).map(|end| rest[..end].to_string())
}

fn collect_diagnostics(app: &AppHandle) -> Vec<DiagIssue> {
    let mut issues: Vec<DiagIssue> = Vec::new();

    let Some(config) = load_config(app) else {
        return vec![DiagIssue {
            severity: "error".into(),
            title: "No configuration found".into(),
            detail: "Open Settings and configure your mods folder before running diagnostics.".into(),
        }];
    };
    let Some(mods_folder) = config.mods_folder else {
        return vec![DiagIssue {
            severity: "error".into(),
            title: "No mods folder configured".into(),
            detail: "Open Settings and pick your mods folder before running diagnostics.".into(),
        }];
    };
    let Ok(inner) = derive_inner_game_folder(&mods_folder) else {
        return vec![DiagIssue {
            severity: "error".into(),
            title: "Invalid mods folder path".into(),
            detail: "The configured path doesn't match the expected Subnautica 2 folder structure.".into(),
        }];
    };

    let win64 = inner.join("Binaries").join("Win64");

    if !win64.join("ue4ss").join("UE4SS.dll").exists() {
        issues.push(DiagIssue {
            severity: "error".into(),
            title: "UE4SS is not installed".into(),
            detail: "Script mods won't load. Download the SN2-specific build from Nexus (mod #36) and install via \"+\u{a0}Install ZIP\".".into(),
        });
    }

    if win64.join("ue4ss").exists() && !win64.join("dwmapi.dll").exists() {
        issues.push(DiagIssue {
            severity: "error".into(),
            title: "UE4SS proxy DLL missing".into(),
            detail: "dwmapi.dll is absent from Binaries\\Win64. UE4SS won't initialise at all. Reinstall the SN2 UE4SS build from Nexus (mod #36).".into(),
        });
    }

    let script_dir = PathBuf::from(&mods_folder);
    let mut hook_map: HashMap<String, Vec<String>> = HashMap::new();

    if let Ok(entries) = fs::read_dir(&script_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let mod_path = entry.path();
            let mod_name = entry.file_name().to_string_lossy().into_owned();
            let enabled = mod_path.join("enabled.txt").exists();

            let non_marker_count = fs::read_dir(&mod_path)
                .map(|d| d.flatten().filter(|e| e.file_name() != "enabled.txt").count())
                .unwrap_or(0);
            if non_marker_count == 0 {
                issues.push(DiagIssue {
                    severity: "warning".into(),
                    title: format!("{}: folder appears empty", mod_name),
                    detail: "No mod files found here — this mod may not have installed correctly.".into(),
                });
            }

            if enabled { scan_hooks(&mod_path, &mod_name, &mut hook_map); }
        }
    }

    for (hook, mods) in &hook_map {
        let mut seen = std::collections::HashSet::new();
        let unique: Vec<&str> = mods.iter()
            .filter(|m| seen.insert(m.as_str()))
            .map(|m| m.as_str())
            .collect();
        if unique.len() > 1 {
            issues.push(DiagIssue {
                severity: "warning".into(),
                title: format!("Hook conflict: {}", hook),
                detail: format!("{} both register this hook — one may override the other.", unique.join(" and ")),
            });
        }
    }

    let pak_dir = inner.join("Content").join("Paks").join("LogicMods");
    if pak_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&pak_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let lower = name.to_lowercase();

                if path.is_file() && (lower.ends_with(".pak") || lower.ends_with(".utoc") || lower.ends_with(".ucas")) {
                    issues.push(DiagIssue {
                        severity: "warning".into(),
                        title: format!("Unmanaged file: {}", name),
                        detail: "This file is loose in LogicMods\\ rather than in a subfolder. Tidekeeper can't track or disable it.".into(),
                    });
                }

                if path.is_dir() {
                    let display = name.trim_end_matches(".disabled").to_string();
                    let (mut has_pak, mut has_utoc, mut has_ucas) = (false, false, false);
                    if let Ok(files) = fs::read_dir(&path) {
                        for f in files.flatten() {
                            let fname = f.file_name().to_string_lossy().to_lowercase();
                            if fname.ends_with(".pak")  { has_pak  = true; }
                            if fname.ends_with(".utoc") { has_utoc = true; }
                            if fname.ends_with(".ucas") { has_ucas = true; }
                        }
                    }
                    if (has_pak || has_utoc || has_ucas) && !(has_pak && has_utoc && has_ucas) {
                        let missing: Vec<&str> = [
                            if !has_pak  { Some(".pak")  } else { None },
                            if !has_utoc { Some(".utoc") } else { None },
                            if !has_ucas { Some(".ucas") } else { None },
                        ].into_iter().flatten().collect();
                        issues.push(DiagIssue {
                            severity: "error".into(),
                            title: format!("{}: incomplete pak files", display),
                            detail: format!("Missing {} — this mod likely won't load in-game. Try reinstalling it.", missing.join(", ")),
                        });
                    }
                }
            }
        }
    }

    if issues.is_empty() {
        issues.push(DiagIssue {
            severity: "ok".into(),
            title: "All checks passed".into(),
            detail: "No issues detected. Your mod setup looks healthy.".into(),
        });
    }

    issues
}

#[tauri::command]
fn run_diagnostics(app: AppHandle) -> Vec<DiagIssue> {
    let issues = collect_diagnostics(&app);
    let issue_count = issues.iter().filter(|i| i.severity != "ok").count();
    write_log(&app, "INFO", &format!("Diagnostics ran — {} issue(s) found", issue_count));
    for issue in &issues {
        match issue.severity.as_str() {
            "error"   => write_log(&app, "ERROR", &format!("Diagnostic: {}", issue.title)),
            "warning" => write_log(&app, "WARN",  &format!("Diagnostic: {}", issue.title)),
            _ => {}
        }
    }
    issues
}

#[tauri::command]
fn export_report(app: AppHandle, export_path: String, generated_at: String) -> Result<(), String> {
    use std::fmt::Write as FmtWrite;
    let mut out = String::new();

    writeln!(out, "=== Tidekeeper Diagnostic Report ===").ok();
    writeln!(out, "Generated : {}", generated_at).ok();
    writeln!(out).ok();

    // Configuration
    writeln!(out, "--- Configuration ---").ok();
    match load_config(&app) {
        None => { writeln!(out, "(no configuration found)").ok(); }
        Some(cfg) => {
            writeln!(out, "Mods folder : {}", cfg.mods_folder.as_deref().unwrap_or("(not set)")).ok();
            writeln!(out, "Nexus API   : {}", if cfg.nexus_api_key.is_some() { "configured" } else { "(not set)" }).ok();
        }
    }
    writeln!(out).ok();

    // System checks
    writeln!(out, "--- System Checks ---").ok();
    for issue in collect_diagnostics(&app) {
        let tag = match issue.severity.as_str() {
            "error"   => "[ERROR]",
            "warning" => "[WARN] ",
            _         => "[OK]   ",
        };
        writeln!(out, "{} {}", tag, issue.title).ok();
        if issue.severity != "ok" {
            writeln!(out, "        {}", issue.detail).ok();
        }
    }
    writeln!(out).ok();

    // Tidekeeper activity log (last 100 entries, oldest→newest)
    writeln!(out, "--- Tidekeeper Activity Log (last 100 entries) ---").ok();
    writeln!(out, "(format: unix_timestamp | LEVEL | message)").ok();
    match fs::read_to_string(log_path(&app)) {
        Err(_) => { writeln!(out, "(log file not found)").ok(); }
        Ok(ref s) if s.trim().is_empty() => { writeln!(out, "(empty)").ok(); }
        Ok(content) => {
            let all: Vec<&str> = content.lines().collect();
            let start = all.len().saturating_sub(100);
            for line in &all[start..] { writeln!(out, "{}", line).ok(); }
        }
    }
    writeln!(out).ok();

    // UE4SS log (last 400 lines)
    writeln!(out, "--- UE4SS Log (last 400 lines) ---").ok();
    let ue4ss_content = load_config(&app)
        .and_then(|c| c.mods_folder)
        .and_then(|mf| PathBuf::from(&mf).parent().map(|p| p.to_path_buf()))
        .map(|d| d.join("UE4SS.log"))
        .and_then(|p| fs::read_to_string(p).ok());

    match ue4ss_content {
        None => { writeln!(out, "(UE4SS.log not found — run the game once with UE4SS installed)").ok(); }
        Some(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(400);
            for line in &lines[start..] { writeln!(out, "{}", line).ok(); }
        }
    }

    fs::write(&export_path, out).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_ue4ss_log(app: AppHandle) -> Result<String, String> {
    let config = load_config(&app).ok_or("No config")?;
    let mods_folder = config.mods_folder.ok_or("No mods folder configured")?;
    let ue4ss_dir = PathBuf::from(&mods_folder)
        .parent()
        .ok_or("Invalid mods folder path")?
        .to_path_buf();
    let log_file = ue4ss_dir.join("UE4SS.log");
    if !log_file.exists() {
        return Err("UE4SS.log not found. Run the game at least once with UE4SS installed to generate it.".into());
    }
    let content = fs::read_to_string(&log_file).map_err(|e| e.to_string())?;
    // Return last 400 lines — UE4SS logs can be very long
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(400);
    Ok(lines[start..].join("\n"))
}

// ── OAuth 2.0 + PKCE ─────────────────────────────────────────────────────────

const OAUTH_REDIRECT_URI: &str = "http://127.0.0.1:8089/callback";
const OAUTH_AUTH_URL: &str     = "https://users.nexusmods.com/oauth/authorize";
const OAUTH_TOKEN_URL: &str    = "https://users.nexusmods.com/oauth/token";

fn generate_code_verifier() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

fn generate_state() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn decode_jwt_payload(token: &str) -> Result<serde_json::Value, String> {
    let part = token.split('.').nth(1).ok_or("Invalid JWT")?;
    let bytes = URL_SAFE_NO_PAD.decode(part).map_err(|e| format!("JWT decode: {}", e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("JWT parse: {}", e))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
}

async fn exchange_oauth_code(code: &str, verifier: &str, client_id: &str) -> Result<TokenResponse, String> {
    let params = [
        ("grant_type",    "authorization_code"),
        ("redirect_uri",  OAUTH_REDIRECT_URI),
        ("client_id",     client_id),
        ("code",          code),
        ("code_verifier", verifier),
    ];
    let resp = Client::new()
        .post(OAUTH_TOKEN_URL)
        .form(&params)
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {}", body));
    }
    resp.json().await.map_err(|e| format!("Token parse: {}", e))
}

async fn do_token_refresh(refresh: &str, client_id: &str) -> Result<TokenResponse, String> {
    let params = [
        ("grant_type",    "refresh_token"),
        ("client_id",     client_id),
        ("refresh_token", refresh),
    ];
    let resp = Client::new()
        .post(OAUTH_TOKEN_URL)
        .form(&params)
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err("Token refresh failed — please sign in again".into());
    }
    resp.json().await.map_err(|e| e.to_string())
}

// Returns (header_name, header_value) for Nexus API requests.
// Uses OAuth Bearer token when available (refreshing if needed), falls back to API key.
async fn get_nexus_auth(app: &AppHandle) -> Result<(String, String), String> {
    let config = load_config(app).ok_or("No config")?;

    if let (Some(token), Some(exp), Some(refresh), Some(client_id)) = (
        config.nexus_token.clone(),
        config.nexus_token_expiry,
        config.nexus_refresh_token.clone(),
        config.nexus_client_id.clone(),
    ) {
        if now_secs() < exp.saturating_sub(60) {
            return Ok(("Authorization".into(), format!("Bearer {}", token)));
        }
        // Expired — try refresh
        if let Ok(new_tokens) = do_token_refresh(&refresh, &client_id).await {
            if let Ok(payload) = decode_jwt_payload(&new_tokens.access_token) {
                let new_exp = payload["exp"].as_u64().unwrap_or(0);
                if let Some(mut cfg) = load_config(app) {
                    cfg.nexus_token         = Some(new_tokens.access_token.clone());
                    cfg.nexus_refresh_token = Some(new_tokens.refresh_token);
                    cfg.nexus_token_expiry  = Some(new_exp);
                    cfg.nexus_username      = payload["user"]["username"].as_str().map(String::from);
                    cfg.nexus_is_premium    = Some(
                        payload["user"]["membership_roles"].as_array()
                            .map(|r| r.iter().any(|v| matches!(v.as_str(), Some("premium") | Some("lifetimepremium"))))
                            .unwrap_or(false)
                    );
                    let _ = save_config_inner(app, &cfg);
                }
                return Ok(("Authorization".into(), format!("Bearer {}", new_tokens.access_token)));
            }
        }
        // Refresh failed — fall through to API key
    }

    config.nexus_api_key
        .map(|k| ("apikey".into(), k))
        .ok_or_else(|| "No Nexus authentication. Sign in with Nexus Mods or add an API key in Settings.".into())
}

async fn handle_oauth_callback(
    listener: std::net::TcpListener,
    expected_state: String,
    code_verifier: String,
    client_id: String,
    app: AppHandle,
) {
    let cb = tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, BufReader, Write};
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(&stream);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;

        // "GET /callback?code=...&state=... HTTP/1.1"
        let query = line.split_whitespace().nth(1)
            .and_then(|p| p.split_once('?')).map(|(_, q)| q).unwrap_or("");

        let mut code  = None;
        let mut state = None;
        for param in query.split('&') {
            if let Some(v) = param.strip_prefix("code=")  { code  = Some(v.to_string()); }
            if let Some(v) = param.strip_prefix("state=") { state = Some(v.to_string()); }
        }

        let html = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
            <html><head><title>Tidekeeper</title></head>\
            <body style='font-family:sans-serif;text-align:center;padding:60px;background:#0d1117;color:#e0e0e0'>\
            <h2 style='color:#00d4ff'>\u{2713} Signed in! You can close this tab.</h2>\
            <p>Return to Tidekeeper to continue.</p>\
            </body></html>";
        let _ = stream.write_all(html.as_bytes());

        match (code, state) {
            (Some(c), Some(s)) => Ok((c, s)),
            _ => Err("OAuth callback missing code or state".to_string()),
        }
    }).await;

    let (code, state) = match cb {
        Ok(Ok(pair)) => pair,
        Ok(Err(e))   => { let _ = app.emit("nexus-oauth-error", e); return; }
        Err(e)       => { let _ = app.emit("nexus-oauth-error", e.to_string()); return; }
    };

    if state != expected_state {
        let _ = app.emit("nexus-oauth-error", "Authentication failed (state mismatch)");
        return;
    }

    let tokens = match exchange_oauth_code(&code, &code_verifier, &client_id).await {
        Ok(t)  => t,
        Err(e) => { let _ = app.emit("nexus-oauth-error", e); return; }
    };

    let payload = match decode_jwt_payload(&tokens.access_token) {
        Ok(p)  => p,
        Err(e) => { let _ = app.emit("nexus-oauth-error", e); return; }
    };

    let username   = payload["user"]["username"].as_str().unwrap_or("").to_string();
    let is_premium = payload["user"]["membership_roles"].as_array()
        .map(|r| r.iter().any(|v| matches!(v.as_str(), Some("premium") | Some("lifetimepremium"))))
        .unwrap_or(false);
    let exp = payload["exp"].as_u64().unwrap_or(0);

    if let Some(mut cfg) = load_config(&app) {
        cfg.nexus_token         = Some(tokens.access_token);
        cfg.nexus_refresh_token = Some(tokens.refresh_token);
        cfg.nexus_token_expiry  = Some(exp);
        cfg.nexus_username      = Some(username.clone());
        cfg.nexus_is_premium    = Some(is_premium);
        let _ = save_config_inner(&app, &cfg);
    }

    write_log(&app, "INFO", &format!("Nexus OAuth sign-in: {}", username));
    let _ = app.emit("nexus-oauth-complete", serde_json::json!({
        "username":  username,
        "isPremium": is_premium,
    }));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in:  bool,
    pub username:   Option<String>,
    pub is_premium: bool,
}

#[tauri::command]
fn nexus_get_auth_status(app: AppHandle) -> AuthStatus {
    match load_config(&app) {
        Some(cfg) if cfg.nexus_token.is_some() => AuthStatus {
            signed_in:  true,
            username:   cfg.nexus_username,
            is_premium: cfg.nexus_is_premium.unwrap_or(false),
        },
        _ => AuthStatus { signed_in: false, username: None, is_premium: false },
    }
}

// Starts the OAuth flow. Binds the local callback server, then returns the
// authorize URL for the frontend to open in the browser.
#[tauri::command]
async fn nexus_oauth_login(app: AppHandle) -> Result<String, String> {
    let config    = load_config(&app).ok_or("No config")?;
    let client_id = config.nexus_client_id.unwrap_or_else(|| "public_test".into());

    let verifier  = generate_code_verifier();
    let challenge = generate_code_challenge(&verifier);
    let state     = generate_state();

    // Bind BEFORE returning the URL so we're listening when the browser redirects back.
    let listener = std::net::TcpListener::bind("127.0.0.1:8089")
        .map_err(|e| format!("Could not start local auth server on port 8089: {}", e))?;

    let redirect_encoded = "http%3A%2F%2F127.0.0.1%3A8089%2Fcallback";
    let auth_url = format!(
        "{}?client_id={}&response_type=code&scope=&redirect_uri={}&state={}&code_challenge_method=S256&code_challenge={}",
        OAUTH_AUTH_URL, client_id, redirect_encoded, state, challenge
    );

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        handle_oauth_callback(listener, state, verifier, client_id, app_clone).await;
    });

    Ok(auth_url)
}

#[tauri::command]
fn nexus_oauth_logout(app: AppHandle) -> Result<(), String> {
    if let Some(mut cfg) = load_config(&app) {
        cfg.nexus_token         = None;
        cfg.nexus_refresh_token = None;
        cfg.nexus_token_expiry  = None;
        cfg.nexus_username      = None;
        cfg.nexus_is_premium    = None;
        save_config_inner(&app, &cfg)?;
    }
    write_log(&app, "INFO", "Nexus OAuth signed out");
    Ok(())
}

// ── App updater ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

async fn try_check_update(app: &AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.to_string()),
            notes: update.body.clone(),
        }),
        None => Ok(UpdateInfo { available: false, version: None, notes: None }),
    }
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> UpdateInfo {
    // Silently return available:false on any error (e.g. dev mode, no network)
    try_check_update(&app).await.unwrap_or(UpdateInfo { available: false, version: None, notes: None })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?
        .ok_or("No update available")?;

    let version = update.version.clone();

    // Download the NSIS zip directly — bypasses Tauri's internal NSIS runner
    // which deadlocks because it waits for Tidekeeper to close while Tidekeeper
    // waits for it to finish.
    let zip_url = format!(
        "https://github.com/ToobsTube/Tidekeeper/releases/download/v{0}/Tidekeeper_{0}_x64-setup.nsis.zip",
        version
    );
    let zip_bytes = reqwest::get(&zip_url)
        .await.map_err(|e| format!("Download failed: {}", e))?
        .bytes().await.map_err(|e| format!("Download read failed: {}", e))?;

    // Extract the NSIS exe from the zip
    let temp_dir = std::env::temp_dir();
    let nsis_path = temp_dir.join("tidekeeper_update.exe");
    {
        let cursor = io::Cursor::new(zip_bytes.as_ref());
        let mut archive = zip::ZipArchive::new(cursor)
            .map_err(|e| format!("Zip error: {}", e))?;
        let mut found = false;
        for i in 0..archive.len() {
            let mut zf = archive.by_index(i).map_err(|e| e.to_string())?;
            if zf.name().ends_with(".exe") {
                let mut out = fs::File::create(&nsis_path).map_err(|e| e.to_string())?;
                io::copy(&mut zf, &mut out).map_err(|e| e.to_string())?;
                found = true;
                break;
            }
        }
        if !found {
            return Err("Installer not found in update package".to_string());
        }
    }

    // Write a cmd trampoline: waits for us to exit, runs NSIS silently,
    // then relaunches Tidekeeper. Uses .cmd instead of .ps1 to avoid AMSI blocking.
    let our_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cmd_path = temp_dir.join("tidekeeper_update.cmd");
    let nsis_str = nsis_path.to_string_lossy().replace('"', "\"\"");
    let exe_str = our_exe.to_string_lossy().replace('"', "\"\"");
    let script = format!(
        "@echo off\r\n\
        echo started >> \"%TEMP%\\tidekeeper_update_log.txt\"\r\n\
        ping 127.0.0.1 -n 4 > nul\r\n\
        \"{}\" /S\r\n\
        echo nsis done >> \"%TEMP%\\tidekeeper_update_log.txt\"\r\n\
        ping 127.0.0.1 -n 2 > nul\r\n\
        start \"\" \"{}\"\r\n\
        echo relaunch attempted >> \"%TEMP%\\tidekeeper_update_log.txt\"\r\n",
        nsis_str, exe_str
    );
    fs::write(&cmd_path, &script).map_err(|e| e.to_string())?;

    // Launch the trampoline detached so it survives our process exiting
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        std::process::Command::new("cmd.exe")
            .args(["/c", cmd_path.to_str().unwrap_or("")])
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map_err(|e| format!("Failed to launch updater: {}", e))?;
    }

    std::process::exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second launch attempted — bring existing window to front
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // Forward any NXM URL passed as a CLI argument
            for arg in &argv {
                if arg.starts_with("nxm://") {
                    let h = app.clone();
                    let url = arg.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = process_nxm(&h, url).await {
                            write_log(&h, "ERROR", &format!("NXM download failed: {}", e));
                            let _ = h.emit("nxm-error", e);
                        }
                    });
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                                write_log(&h, "ERROR", &format!("NXM download failed: {}", e));
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
            find_subnautica2,
            create_mod_structure,
            scan_mods,
            verify_mod,
            rollback_mod,
            toggle_mod,
            uninstall_mod,
            install_from_zip,
            peek_zip_name,
            launch_game,
            check_ue4ss,
            handle_nxm,
            get_pending_nxm,
            switch_profile,
            save_profile,
            delete_profile,
            export_profile,
            import_profile,
            get_unmanaged_paks,
            adopt_unmanaged_pak,
            export_modpack,
            peek_modpack,
            install_modpack,
            nexus_get_auth_status,
            nexus_oauth_login,
            nexus_oauth_logout,
            validate_nexus_key,
            get_nexus_mod_files,
            install_nexus_mod,
            check_mod_updates,
            run_diagnostics,
            export_report,
            get_log,
            clear_log,
            get_ue4ss_log,
            check_for_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error running Tidekeeper");
}
