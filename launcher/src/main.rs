//! Windows stand-in for CCodex's `#!/bin/sh` shims (src/management/commands.ts `shim`). Installed as
//! `~/.ccodex/bin/codex.exe` and `ccodex.exe`; it runs `<node> <CCODEX_HOME>/current/node_modules/@gkorepanov/ccodex/
//! dist/cli/main.js [args]` with inherited stdio and returns its exit code. `ccodex.exe setup|update|uninstall|doctor|auth`
//! prefers a newer globally installed package, as the POSIX shim does.
//!
//! The Node path (absolute: the Codex app's PATH may not have it) comes from `ccodex-launcher.cfg` beside the exe,
//! `key=value` lines written by `ccodex setup`: `node`, `home`, and optionally `npm_root` (`npm root -g`).

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const PACKAGE: &str = "@gkorepanov/ccodex";
const SIDECAR: &str = "ccodex-launcher.cfg";
const MANAGEMENT: [&str; 5] = ["setup", "update", "uninstall", "doctor", "auth"];

fn fail(code: u8, message: &str) -> ExitCode {
    eprintln!("{message}");
    ExitCode::from(code)
}

fn sidecar(dir: &Path) -> HashMap<String, String> {
    fs::read_to_string(dir.join(SIDECAR))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .filter(|(_, value)| !value.is_empty())
        .collect()
}

fn node_on_path() -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|dir| dir.join("node.exe"))
        .find(|path| path.is_file())
}

fn package_dir(root: &Path) -> PathBuf {
    PACKAGE.split('/').fold(root.to_path_buf(), |path, part| path.join(part))
}

fn main() -> ExitCode {
    if env::var_os("CCODEX_SHIM_ACTIVE").is_some_and(|value| value == "1") {
        return fail(70, "CCodex recursion guard: managed shim attempted to invoke itself.");
    }
    let Ok(exe) = env::current_exe() else {
        return fail(1, "CCodex launcher: cannot locate its own executable.");
    };
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = exe.file_stem().map(|stem| stem.to_string_lossy().to_lowercase()).unwrap_or_default();
    let config = sidecar(&dir);
    let home = env::var_os("CCODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| config.get("home").map(PathBuf::from))
        .or_else(|| dir.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let node = config.get("node").map(PathBuf::from).filter(|path| path.is_file()).or_else(node_on_path);
    let Some(node) = node else {
        return fail(69, &format!("CCodex Node runtime is missing. Reinstall Node.js, then run: npm install -g {PACKAGE} && ccodex setup"));
    };

    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let current = package_dir(&home.join("current").join("node_modules"));
    let mut script = current.join("dist").join("cli").join("main.js");
    // Management commands prefer a newer globally installed package (npm i -g → ccodex setup).
    let management = args.first().and_then(|arg| arg.to_str()).is_some_and(|arg| MANAGEMENT.contains(&arg));
    if name == "ccodex" && management {
        if let Some(root) = config.get("npm_root") {
            let global = package_dir(Path::new(root));
            let global_main = global.join("dist").join("cli").join("main.js");
            let newer = global_main.is_file()
                && Command::new(&node)
                    .arg(global.join("dist").join("management").join("shimSelect.js"))
                    .arg(current.join("package.json"))
                    .env("CCODEX_SHIM_ACTIVE", "1")
                    .status()
                    .is_ok_and(|status| status.success());
            if newer {
                script = global_main;
            }
        }
    }
    if !script.is_file() {
        return fail(1, &format!("CCodex is not activated ({} is missing). Run: ccodex setup", script.display()));
    }

    windows::keep_std_handles_private();
    let mut child = match Command::new(&node)
        .arg(&script)
        .args(&args)
        .env("CCODEX_SHIM_ACTIVE", "1")
        .env("CCODEX_HOME", &home)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return fail(1, &format!("CCodex launcher: failed to start {}: {error}", node.display())),
    };
    windows::bind_to_launcher(&child);
    match child.wait() {
        // Windows exit codes are 32-bit (0xC000013A after Ctrl+C); ExitCode takes a byte, so use process::exit.
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => fail(1, &format!("CCodex launcher: waiting for Node failed: {error}")),
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;

    #[repr(C)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x1000;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
        fn GetStdHandle(which: u32) -> Handle;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    }

    const STD_HANDLES: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
    const HANDLE_FLAG_INHERIT: u32 = 1;

    /// Node gets inheritable duplicates of the launcher's std handles from std's spawn; the originals must not be
    /// inheritable too, or every process Node starts (the detached daemon) holds the caller's pipes open for good.
    pub fn keep_std_handles_private() {
        for which in STD_HANDLES {
            unsafe {
                let handle = GetStdHandle(which);
                if !handle.is_null() && handle as isize != -1 {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
    }

    /// Ctrl+C reaches every process on the console: the launcher outlives it so Node decides, and reports its exit.
    unsafe extern "system" fn ignore(_event: u32) -> i32 {
        1
    }

    /// Node ends with the launcher (the Codex app stops `codex.exe`, not its children). Its own children break away
    /// silently: the detached app-server daemon a frontend starts must outlive both. Best effort.
    pub fn bind_to_launcher(child: &Child) {
        unsafe {
            // A handler, not SetConsoleCtrlHandler(NULL): ignoring Ctrl+C that way would be inherited by Node.
            SetConsoleCtrlHandler(Some(ignore), 1);
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return;
            }
            let mut limits: ExtendedLimits = std::mem::zeroed();
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let size = std::mem::size_of::<ExtendedLimits>() as u32;
            if SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, &limits as *const _ as *const c_void, size) != 0 {
                AssignProcessToJobObject(job, child.as_raw_handle() as Handle);
            }
            // The handle stays open until the launcher exits: closing it is what ends Node.
        }
    }
}

#[cfg(not(windows))]
mod windows {
    pub fn bind_to_launcher(_child: &std::process::Child) {}
    pub fn keep_std_handles_private() {}
}
