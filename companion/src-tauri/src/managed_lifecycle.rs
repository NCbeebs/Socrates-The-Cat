//! Extension-managed process lifecycle (Phase 2): named-pipe control plane and session mutex.
//! Active only when `--habitat-managed` or `HABITAT_MANAGED=1` is set; source `socrates` launches
//! never enable this path. Pairs with the VS Code extension controller (Phase 3) and `lib.rs` startup.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::runtime_log;

pub const PROTOCOL_VERSION: u32 = 1;
const MUTEX_NAME_PREFIX: &str = "Local\\SocratesHabitatManagedV1";
const PIPE_NAME_PREFIX: &str = r"\\.\pipe\Socrates.Habitat.Managed.v1";
const MAX_MESSAGE_BYTES: usize = 4096;
const MAX_CLIENTS: usize = 32;
const LAST_OWNER_GRACE: Duration = Duration::from_secs(5);
const INITIAL_ATTACHMENT_DEADLINE: Duration = Duration::from_secs(60);
const DUPLICATE_WAIT: Duration = Duration::from_secs(30);
const PIPE_CONNECT_SLICE_MS: u32 = 250;
const MAX_UNCONNECTED_CLIENTS: usize = 8;
const UNBOUND_FIRST_OP_DEADLINE: Duration = Duration::from_secs(10);
const PROBE_IO_DEADLINE: Duration = Duration::from_secs(2);
const READ_POLL: Duration = Duration::from_millis(25);

static RUNTIME_READY: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static SESSION_ID: OnceLock<u32> = OnceLock::new();

pub fn session_id() -> u32 {
    *SESSION_ID.get_or_init(read_session_id)
}

pub fn managed_pipe_name() -> String {
    format!("{PIPE_NAME_PREFIX}.{}", session_id())
}

pub fn managed_mutex_name() -> String {
    format!("{MUTEX_NAME_PREFIX}.{}", session_id())
}

fn read_session_id() -> u32 {
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::GetCurrentProcessId;

    let mut session_id = 0u32;
    let pid = unsafe { GetCurrentProcessId() };
    if unsafe { ProcessIdToSessionId(pid, &mut session_id) }.is_err() {
        runtime_log::warn("managed", "session_id", "ProcessIdToSessionId failed; using 0.");
        return 0;
    }
    session_id
}

/// Returns whether this process should enter the managed control plane.
pub fn is_managed_launch() -> bool {
    managed_launch_from(
        std::env::args().collect::<Vec<_>>(),
        std::env::var("HABITAT_MANAGED").ok(),
    )
}

fn managed_launch_from(args: Vec<String>, habitat_managed: Option<String>) -> bool {
    if args.iter().any(|a| a == "--habitat-managed") {
        return true;
    }
    match habitat_managed {
        Some(v) => {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("on")
        }
        None => false,
    }
}

/// Pre-Tauri gate: duplicate managed starters exit before overlay/UIA workers run.
pub fn resolve_managed_launch() -> Result<Option<ManagedSession>, String> {
    if !is_managed_launch() {
        return Ok(None);
    }
    runtime_log::info(
        "managed",
        "launch",
        &format!(
            "Managed session requested; pipe={} mutex={}",
            managed_pipe_name(),
            managed_mutex_name()
        ),
    );
    match try_begin_server_session() {
        Ok(session) => {
            runtime_log::info("managed", "session_owner", "This process owns the managed session.");
            Ok(Some(session))
        }
        Err(ManagedLaunchError::Duplicate) => Err("duplicate".into()),
        Err(ManagedLaunchError::Failed(message)) => Err(message),
    }
}

pub fn register_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub fn mark_runtime_ready() {
    if is_managed_launch() {
        RUNTIME_READY.store(true, Ordering::SeqCst);
        runtime_log::info("managed", "control_ready", "Managed control plane ready.");
    }
}

/// Interrupt pipe accept and release mutex without blocking the main thread (Tauri exit path).
pub fn finalize_managed_session(session: &mut ManagedSession) {
    begin_control_plane_shutdown();
    session.release_mutex();
}

/// Single shutdown entry: sets the flag once, stops the listener, then asks Tauri to exit.
pub fn request_managed_shutdown(reason: &'static str) {
    if !is_managed_launch() {
        return;
    }
    let first = !SHUTDOWN_REQUESTED.swap(true, Ordering::SeqCst);
    if first {
        runtime_log::info("managed", "shutdown", reason);
        wakeup_pipe_accept();
    }
    if let Some(app) = APP_HANDLE.get() {
        app.exit(0);
    }
}

pub struct ManagedSession {
    mutex: Option<windows::Win32::Foundation::HANDLE>,
    server: Option<JoinHandle<()>>,
}

impl ManagedSession {
    pub fn release_mutex(&mut self) {
        if let Some(mutex) = self.mutex.take() {
            unsafe {
                let _ = windows::Win32::System::Threading::ReleaseMutex(mutex);
                let _ = windows::Win32::Foundation::CloseHandle(mutex);
            }
        }
    }

    fn shutdown_server(&mut self) {
        begin_control_plane_shutdown();
        if let Some(server) = self.server.take() {
            thread::spawn(move || {
                let _ = server.join();
            });
        }
    }
}

impl Drop for ManagedSession {
    fn drop(&mut self) {
        self.shutdown_server();
        self.release_mutex();
    }
}

fn begin_control_plane_shutdown() {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
    wakeup_pipe_accept();
}

/// Unblocks a blocking `ConnectNamedPipe` without closing the listener from another thread.
fn wakeup_pipe_accept() {
    thread::spawn(|| {
        let _ = connect_pipe_client(50);
    });
}

enum ManagedLaunchError {
    Duplicate,
    Failed(String),
}

fn try_begin_server_session() -> Result<ManagedSession, ManagedLaunchError> {
    let mutex = create_session_mutex()?;
    if !mutex.we_own {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(mutex.handle);
        }
        if wait_for_existing_server() {
            return Err(ManagedLaunchError::Duplicate);
        }
        return Err(ManagedLaunchError::Failed(
            "Another managed session holds the mutex but the control pipe did not respond in time."
                .into(),
        ));
    }
    let mut session = ManagedSession {
        mutex: Some(mutex.handle),
        server: None,
    };
    session.server = Some(spawn_pipe_server()?);
    Ok(session)
}

struct MutexOpenResult {
    handle: windows::Win32::Foundation::HANDLE,
    we_own: bool,
}

fn create_session_mutex() -> Result<MutexOpenResult, ManagedLaunchError> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::Foundation::WIN32_ERROR;

    let name = managed_mutex_name();
    let wide = wide_null(&name);
    let handle = unsafe { CreateMutexW(None, true, PCWSTR(wide.as_ptr())) };
    let handle = match handle {
        Ok(h) => h,
        Err(e) => {
            return Err(ManagedLaunchError::Failed(format!(
                "CreateMutexW failed: {e}"
            )));
        }
    };
    let already_exists = unsafe { windows::Win32::Foundation::GetLastError() }
        == WIN32_ERROR(183); // ERROR_ALREADY_EXISTS
    Ok(MutexOpenResult {
        handle,
        we_own: !already_exists,
    })
}

fn wait_for_existing_server() -> bool {
    let deadline = Instant::now() + DUPLICATE_WAIT;
    while Instant::now() < deadline {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            return false;
        }
        if probe_server_status().is_some() {
            return true;
        }
        thread::sleep(Duration::from_millis(PIPE_CONNECT_SLICE_MS as u64));
    }
    false
}

fn probe_server_status() -> Option<StatusPayload> {
    let file = match connect_pipe_client(PIPE_CONNECT_SLICE_MS) {
        Ok(f) => f,
        Err(_) => return None,
    };
    let mut writer = file.try_clone().ok()?;
    let mut reader = BufReader::new(file);
    if !write_line(
        &mut writer,
        &serde_json::to_string(&ClientRequest {
            op: "status".into(),
            client_id: None,
            protocol: Some(PROTOCOL_VERSION),
        })
        .unwrap_or_default(),
    ) {
        return None;
    }
    let line = match read_line_bounded_until(&mut reader, Instant::now() + PROBE_IO_DEADLINE) {
        LineRead::Line(line) => line,
        _ => return None,
    };
    parse_status_response(&line)
}

fn spawn_pipe_server() -> Result<JoinHandle<()>, ManagedLaunchError> {
    let state = Arc::new(ServerState::default());
    let grace_state = state.clone();
    thread::Builder::new()
        .name("habitat-managed-grace".into())
        .spawn(move || {
            while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(500));
                tick_grace_shutdown(&grace_state);
            }
        })
        .map_err(|e| ManagedLaunchError::Failed(format!("grace thread: {e}")))?;
    let handle = thread::Builder::new()
        .name("habitat-managed-pipe".into())
        .spawn(move || pipe_server_loop(state))
        .map_err(|e| ManagedLaunchError::Failed(format!("pipe server thread: {e}")))?;
    Ok(handle)
}

struct ServerState {
    clients: Mutex<ClientRegistry>,
    active_connections: AtomicUsize,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            clients: Mutex::new(ClientRegistry::default()),
            active_connections: AtomicUsize::new(0),
        }
    }
}

struct ClientRegistry {
    owners: HashSet<String>,
    grace_started: Option<Instant>,
    unowned_started: Option<Instant>,
}

impl Default for ClientRegistry {
    fn default() -> Self {
        Self {
            owners: HashSet::new(),
            grace_started: None,
            unowned_started: Some(Instant::now()),
        }
    }
}

impl ClientRegistry {
    fn owner_count(&self) -> usize {
        self.owners.len()
    }

    fn on_attach(&mut self, client_id: &str, already_bound: bool) -> Result<(), &'static str> {
        if self.owners.len() >= MAX_CLIENTS {
            return Err("too_many_clients");
        }
        if self.owners.contains(client_id) && !already_bound {
            return Err("client_id_in_use");
        }
        self.owners.insert(client_id.to_string());
        self.grace_started = None;
        self.unowned_started = None;
        Ok(())
    }

    fn on_release(&mut self, client_id: &str) {
        self.owners.remove(client_id);
        if self.owners.is_empty() {
            self.grace_started = Some(Instant::now());
        }
    }

    fn on_disconnect(&mut self, client_id: &str) {
        self.on_release(client_id);
    }

    fn should_exit_after_grace(&self) -> bool {
        if !self.owners.is_empty() {
            return false;
        }
        if let Some(started) = self.grace_started {
            if started.elapsed() >= LAST_OWNER_GRACE {
                return true;
            }
        }
        if let Some(started) = self.unowned_started {
            if started.elapsed() >= INITIAL_ATTACHMENT_DEADLINE {
                return true;
            }
        }
        false
    }
}

fn pipe_server_loop(state: Arc<ServerState>) {
    while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        let pipe = match create_pipe_instance() {
            Ok(p) => p,
            Err(e) => {
                runtime_log::error("managed", "pipe_create_failed", &e);
                thread::sleep(Duration::from_millis(200));
                continue;
            }
        };
        let connected = unsafe { connect_pipe_instance(pipe) };
        if connected.is_err() || SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(pipe);
            }
            continue;
        }
        let owners = state
            .clients
            .lock()
            .expect("managed clients lock")
            .owner_count();
        let active = state.active_connections.load(Ordering::SeqCst);
        if active >= owners + MAX_UNCONNECTED_CLIENTS {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(pipe);
            }
            continue;
        }
        state.active_connections.fetch_add(1, Ordering::SeqCst);
        let file = unsafe { File::from_raw_handle(pipe.0 as RawHandle) };
        let state_for_client = state.clone();
        thread::spawn(move || {
            let client_id = serve_client(&state_for_client, file);
            if let Some(id) = client_id {
                let mut reg = state_for_client.clients.lock().expect("managed clients lock");
                reg.on_disconnect(&id);
                maybe_schedule_shutdown(&reg);
            }
            state_for_client
                .active_connections
                .fetch_sub(1, Ordering::SeqCst);
            tick_grace_shutdown(&state_for_client);
        });
        tick_grace_shutdown(&state);
    }
}

fn tick_grace_shutdown(state: &Arc<ServerState>) {
    let should = state
        .clients
        .lock()
        .expect("managed clients lock")
        .should_exit_after_grace();
    if should && !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        request_managed_shutdown("No owners within deadline; shutting down.");
    }
}

fn maybe_schedule_shutdown(reg: &ClientRegistry) {
    if reg.should_exit_after_grace() {
        request_managed_shutdown("Last owner disconnected; grace elapsed.");
    }
}

fn serve_client(state: &Arc<ServerState>, file: File) -> Option<String> {
    let mut reader = BufReader::new(file.try_clone().ok()?);
    let mut writer = file;
    let mut bound_client: Option<String> = None;
    while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        let line = if bound_client.is_none() {
            match read_line_bounded_until(
                &mut reader,
                Instant::now() + UNBOUND_FIRST_OP_DEADLINE,
            ) {
                LineRead::Line(line) => line,
                LineRead::Eof | LineRead::Timeout => break,
            }
        } else {
            match read_line_bounded(&mut reader) {
                Some(l) => l,
                None => break,
            }
        };
        let request = match parse_request(&line) {
            Ok(r) => r,
            Err(code) => {
                let _ = write_line(
                    &mut writer,
                    &serde_json::to_string(&ServerResponse::err(code)).unwrap(),
                );
                continue;
            }
        };
        let response = handle_request(state, &request, &mut bound_client);
        if !write_line(&mut writer, &serde_json::to_string(&response).unwrap()) {
            break;
        }
        if request.op == "stop" {
            request_managed_shutdown("Explicit stop requested.");
            break;
        }
        tick_grace_shutdown(state);
    }
    bound_client
}

fn handle_request(
    state: &Arc<ServerState>,
    request: &ClientRequest,
    bound_client: &mut Option<String>,
) -> ServerResponse {
    match request.op.as_str() {
        "attach" => {
            let client_id = match request.client_id.as_deref() {
                Some(id) if !id.is_empty() && id.len() <= 128 => id,
                _ => return ServerResponse::err("invalid_client_id"),
            };
            if let Some(proto) = request.protocol {
                if proto != PROTOCOL_VERSION {
                    return ServerResponse::err("protocol_mismatch");
                }
            }
            if let Some(bound) = bound_client.as_deref() {
                if bound != client_id {
                    return ServerResponse::err("connection_already_bound");
                }
            }
            let already_bound = bound_client.as_deref() == Some(client_id);
            let mut reg = state.clients.lock().expect("managed clients lock");
            if let Err(code) = reg.on_attach(client_id, already_bound) {
                return ServerResponse::err(code);
            }
            *bound_client = Some(client_id.to_string());
            ServerResponse::attached(status_payload(&reg))
        }
        "release" => {
            let client_id = match request.client_id.as_deref() {
                Some(id) if !id.is_empty() && id.len() <= 128 => id,
                _ => return ServerResponse::err("invalid_client_id"),
            };
            match bound_client.as_deref() {
                Some(bound) if bound == client_id => {}
                _ => return ServerResponse::err("release_not_bound"),
            }
            let mut reg = state.clients.lock().expect("managed clients lock");
            reg.on_release(client_id);
            *bound_client = None;
            maybe_schedule_shutdown(&reg);
            ServerResponse::ok("released", status_payload(&reg))
        }
        "status" => {
            if let Some(proto) = request.protocol {
                if proto != PROTOCOL_VERSION {
                    return ServerResponse::err("protocol_mismatch");
                }
            }
            ServerResponse::ok("status", status_payload(&reg_lock(state)))
        }
        "stop" => ServerResponse::ok("stopping", status_payload(&reg_lock(state))),
        _ => ServerResponse::err("unknown_op"),
    }
}

fn reg_lock(state: &Arc<ServerState>) -> std::sync::MutexGuard<'_, ClientRegistry> {
    state.clients.lock().expect("managed clients lock")
}

fn status_payload(reg: &ClientRegistry) -> StatusPayload {
    StatusPayload {
        protocol: PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").to_string(),
        ready: RUNTIME_READY.load(Ordering::SeqCst),
        owners: reg.owner_count(),
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct ClientRequest {
    op: String,
    client_id: Option<String>,
    protocol: Option<u32>,
}

#[derive(Debug, Serialize)]
struct ServerResponse {
    ok: bool,
    op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<StatusPayload>,
}

impl ServerResponse {
    fn err(code: &'static str) -> Self {
        Self {
            ok: false,
            op: "error".into(),
            error: Some(code.into()),
            status: None,
        }
    }

    fn ok(op: &str, status: StatusPayload) -> Self {
        Self {
            ok: true,
            op: op.into(),
            error: None,
            status: Some(status),
        }
    }

    fn attached(status: StatusPayload) -> Self {
        Self {
            ok: true,
            op: "attached".into(),
            error: None,
            status: Some(status),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusPayload {
    protocol: u32,
    version: String,
    ready: bool,
    owners: usize,
}

fn parse_request(line: &str) -> Result<ClientRequest, &'static str> {
    if line.trim().is_empty() {
        return Err("empty_message");
    }
    if line.len() > MAX_MESSAGE_BYTES {
        return Err("message_too_large");
    }
    serde_json::from_str(line).map_err(|_| "invalid_json")
}

fn parse_status_response(line: &str) -> Option<StatusPayload> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return None;
    }
    let status = value.get("status")?;
    let payload: StatusPayload = serde_json::from_value(status.clone()).ok()?;
    validate_status_payload(&payload).ok()?;
    Some(payload)
}

fn validate_status_payload(payload: &StatusPayload) -> Result<(), ()> {
    if payload.protocol != PROTOCOL_VERSION {
        return Err(());
    }
    if payload.version.is_empty() || payload.version.len() > 64 {
        return Err(());
    }
    let core = payload.version.split('-').next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return Err(());
    }
    if !parts.iter().all(|part| {
        !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())
    }) {
        return Err(());
    }
    Ok(())
}

fn write_line(file: &mut File, line: &str) -> bool {
    if line.len() > MAX_MESSAGE_BYTES {
        return false;
    }
    let mut payload = line.to_string();
    payload.push('\n');
    file.write_all(payload.as_bytes()).is_ok()
}

enum LineRead {
    Line(String),
    Eof,
    Timeout,
}

fn read_line_bounded_until(reader: &mut BufReader<File>, deadline: Instant) -> LineRead {
    let mut line = Vec::new();
    while line.len() <= MAX_MESSAGE_BYTES {
        if Instant::now() >= deadline || SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            return LineRead::Timeout;
        }
        match pipe_peek(reader) {
            PipePeek::Broken => return LineRead::Eof,
            PipePeek::Empty => {
                thread::sleep(READ_POLL);
                continue;
            }
            PipePeek::Readable => {
                let mut byte = [0u8; 1];
                match reader.read(&mut byte) {
                    Ok(0) => return LineRead::Eof,
                    Ok(_) => {
                        if byte[0] == b'\n' {
                            let text = match String::from_utf8(line) {
                                Ok(value) => value,
                                Err(_) => return LineRead::Eof,
                            };
                            return LineRead::Line(text.trim_end_matches('\r').to_string());
                        }
                        line.push(byte[0]);
                    }
                    Err(_) => return LineRead::Eof,
                }
            }
        }
    }
    LineRead::Timeout
}

enum PipePeek {
    Empty,
    Readable,
    Broken,
}

fn pipe_peek(reader: &mut BufReader<File>) -> PipePeek {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::System::Pipes::PeekNamedPipe;

    let buffered = reader.buffer();
    if !buffered.is_empty() {
        return PipePeek::Readable;
    }

    let handle = windows::Win32::Foundation::HANDLE(reader.get_mut().as_raw_handle() as *mut _);
    let mut bytes_avail = 0u32;
    let ok = unsafe {
        PeekNamedPipe(
            handle,
            None,
            0,
            None,
            Some(&mut bytes_avail),
            None,
        )
    };
    if ok.is_err() {
        return PipePeek::Broken;
    }
    if bytes_avail > 0 {
        PipePeek::Readable
    } else {
        PipePeek::Empty
    }
}

fn read_line_bounded(reader: &mut BufReader<File>) -> Option<String> {
    let mut line = Vec::new();
    while line.len() <= MAX_MESSAGE_BYTES {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte) {
            Ok(0) => {
                if line.is_empty() {
                    return None;
                }
                let text = String::from_utf8(line).ok()?;
                return Some(text.trim_end_matches('\r').to_string());
            }
            Ok(_) => {
                if byte[0] == b'\n' {
                    let text = String::from_utf8(line).ok()?;
                    return Some(text.trim_end_matches('\r').to_string());
                }
                line.push(byte[0]);
            }
            Err(_) => return None,
        }
    }
    None
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn connect_pipe_client(wait_ms: u32) -> Result<File, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::WaitNamedPipeW;

    let wide = wide_null(&managed_pipe_name());
    unsafe {
        if !WaitNamedPipeW(PCWSTR(wide.as_ptr()), wait_ms).as_bool() {
            return Err("WaitNamedPipeW failed".into());
        }
    }
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    };
    let handle = handle.map_err(|e| format!("CreateFileW: {e}"))?;
    Ok(unsafe { File::from_raw_handle(handle.0 as RawHandle) })
}

struct OwnedSecurityDescriptor(windows::Win32::Security::PSECURITY_DESCRIPTOR);

impl Drop for OwnedSecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.0.is_null() {
            unsafe {
                let _ = windows::Win32::Foundation::LocalFree(Some(
                    windows::Win32::Foundation::HLOCAL(self.0.0),
                ));
            }
        }
    }
}

struct PipeSecurityContext {
    // Keep the descriptor alive while SECURITY_ATTRIBUTES borrows its allocation.
    _descriptor: OwnedSecurityDescriptor,
    attributes: windows::Win32::Security::SECURITY_ATTRIBUTES,
}

fn build_pipe_security_context() -> Result<PipeSecurityContext, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

    let sid = current_logon_sid_string()?;
    let sddl = format!("D:(A;;GA;;;{})", sid);
    let wide = wide_null(&sddl);
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(wide.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|e| format!("ConvertStringSecurityDescriptorToSecurityDescriptorW: {e}"))?;
    }
    let owned = OwnedSecurityDescriptor(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: owned.0.0,
        bInheritHandle: windows::core::BOOL(0),
    };
    Ok(PipeSecurityContext {
        _descriptor: owned,
        attributes,
    })
}

struct OwnedToken(windows::Win32::Foundation::HANDLE);

impl Drop for OwnedToken {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

fn current_logon_sid_string() -> Result<String, String> {
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{
        GetTokenInformation, TokenLogonSid, TOKEN_GROUPS, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut raw_token = windows::Win32::Foundation::HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token)
            .map_err(|e| format!("OpenProcessToken: {e}"))?;
    }
    let token = OwnedToken(raw_token);
    let mut length = 0u32;
    unsafe {
        let _ = GetTokenInformation(token.0, TokenLogonSid, None, 0, &mut length);
    }
    let mut buffer = vec![0u8; length as usize];
    unsafe {
        GetTokenInformation(
            token.0,
            TokenLogonSid,
            Some(buffer.as_mut_ptr() as *mut core::ffi::c_void),
            length,
            &mut length,
        )
        .map_err(|e| format!("GetTokenInformation(TokenLogonSid): {e}"))?;
    }
    if buffer.len() < std::mem::size_of::<TOKEN_GROUPS>() {
        return Err("TokenLogonSid buffer too small".into());
    }
    // Win32 returns an unaligned blob; do not form a misaligned reference to TOKEN_GROUPS.
    let groups = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast::<TOKEN_GROUPS>()) };
    if groups.GroupCount == 0 {
        return Err("TokenLogonSid has no logon group".into());
    }
    let sid = groups.Groups[0].Sid;
    if sid.0.is_null() {
        return Err("TokenLogonSid missing SID".into());
    }
    let mut sid_string = windows::core::PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut sid_string)
            .map_err(|e| format!("ConvertSidToStringSidW: {e}"))?;
    }
    let sid = unsafe { sid_string.to_string() }
        .map_err(|e| format!("logon SID string: {e}"));
    unsafe {
        let _ = windows::Win32::Foundation::LocalFree(Some(
            windows::Win32::Foundation::HLOCAL(sid_string.0 as *mut _),
        ));
    }
    sid
}

fn create_pipe_instance() -> Result<windows::Win32::Foundation::HANDLE, String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    let security = build_pipe_security_context()?;
    let wide = wide_null(&managed_pipe_name());
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(PIPE_ACCESS_DUPLEX),
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            windows::Win32::System::Pipes::PIPE_UNLIMITED_INSTANCES,
            MAX_MESSAGE_BYTES as u32,
            MAX_MESSAGE_BYTES as u32,
            0,
            Some(&security.attributes),
        )
    };
    if handle.is_invalid() {
        return Err("CreateNamedPipeW returned invalid handle".into());
    }
    Ok(handle)
}

unsafe fn connect_pipe_instance(pipe: windows::Win32::Foundation::HANDLE) -> Result<(), String> {
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::System::Pipes::ConnectNamedPipe;

    if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        return Err("shutdown".into());
    }
    match ConnectNamedPipe(pipe, None) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == WIN32_ERROR(535).to_hresult() => Ok(()), // ERROR_PIPE_CONNECTED
        Err(e) => Err(format!("ConnectNamedPipe: {e}")),
    }
}

#[cfg(any(test, feature = "habitat-unit-tests"))]
mod unit_tests {
    use super::*;

    pub(super) fn unmanaged_by_default() {
        assert!(!managed_launch_from(vec!["companion.exe".into()], None));
    }

    pub(super) fn managed_flag_and_env() {
        assert!(managed_launch_from(
            vec!["companion.exe".into(), "--habitat-managed".into()],
            None,
        ));
        assert!(managed_launch_from(vec![], Some("1".into())));
        assert!(!managed_launch_from(vec![], Some("0".into())));
    }

    pub(super) fn parse_attach_request() {
        let req = parse_request(r#"{"op":"attach","client_id":"abc","protocol":1}"#).unwrap();
        assert_eq!(req.op, "attach");
        assert_eq!(req.client_id.as_deref(), Some("abc"));
    }

    pub(super) fn grace_exit_only_after_interval() {
        let mut reg = ClientRegistry::default();
        let _ = reg.on_attach("a", false);
        reg.on_release("a");
        assert!(reg.grace_started.is_some());
        assert!(!reg.should_exit_after_grace());
        reg.grace_started = Some(Instant::now() - LAST_OWNER_GRACE - Duration::from_millis(1));
        assert!(reg.should_exit_after_grace());
    }

    pub(super) fn initial_attachment_deadline() {
        let mut reg = ClientRegistry::default();
        assert!(!reg.should_exit_after_grace());
        reg.unowned_started =
            Some(Instant::now() - INITIAL_ATTACHMENT_DEADLINE - Duration::from_millis(1));
        assert!(reg.should_exit_after_grace());
    }

    pub(super) fn client_cap_enforced() {
        let mut reg = ClientRegistry::default();
        for i in 0..MAX_CLIENTS {
            assert!(reg.on_attach(&format!("c{i}"), false).is_ok());
        }
        assert!(reg.on_attach("overflow", false).is_err());
    }

    pub(super) fn validate_status_rejects_bad_protocol() {
        let payload = StatusPayload {
            protocol: 99,
            version: "0.1.0".into(),
            ready: true,
            owners: 0,
        };
        assert!(validate_status_payload(&payload).is_err());
    }

    pub(super) fn parse_request_rejects_empty_and_oversized() {
        assert_eq!(parse_request("   ").unwrap_err(), "empty_message");
        let huge = "a".repeat(MAX_MESSAGE_BYTES + 1);
        assert_eq!(parse_request(&huge).unwrap_err(), "message_too_large");
    }

    pub(super) fn release_not_bound_without_attach() {
        let state = Arc::new(ServerState::default());
        let mut bound = None;
        let req = ClientRequest {
            op: "release".into(),
            client_id: Some("client-a".into()),
            protocol: None,
        };
        let resp = handle_request(&state, &req, &mut bound);
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("release_not_bound"));
    }

    pub(super) fn release_not_bound_for_wrong_client_on_connection() {
        let state = Arc::new(ServerState::default());
        let mut bound = None;
        let attach = ClientRequest {
            op: "attach".into(),
            client_id: Some("owner-a".into()),
            protocol: Some(PROTOCOL_VERSION),
        };
        assert!(handle_request(&state, &attach, &mut bound).ok);
        let release_other = ClientRequest {
            op: "release".into(),
            client_id: Some("owner-b".into()),
            protocol: None,
        };
        let resp = handle_request(&state, &release_other, &mut bound);
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("release_not_bound"));
    }

    pub(super) fn multiple_owners_via_attach() {
        let state = Arc::new(ServerState::default());
        let mut bound_a = None;
        let mut bound_b = None;
        let attach_a = ClientRequest {
            op: "attach".into(),
            client_id: Some("owner-a".into()),
            protocol: Some(PROTOCOL_VERSION),
        };
        let attach_b = ClientRequest {
            op: "attach".into(),
            client_id: Some("owner-b".into()),
            protocol: Some(PROTOCOL_VERSION),
        };
        assert!(handle_request(&state, &attach_a, &mut bound_a).ok);
        assert!(handle_request(&state, &attach_b, &mut bound_b).ok);
        let reg = state.clients.lock().expect("lock");
        assert_eq!(reg.owner_count(), 2);
    }

    pub(super) fn attach_rejects_second_client_on_same_connection() {
        let state = Arc::new(ServerState::default());
        let mut bound = None;
        let first = ClientRequest {
            op: "attach".into(),
            client_id: Some("owner-a".into()),
            protocol: Some(PROTOCOL_VERSION),
        };
        assert!(handle_request(&state, &first, &mut bound).ok);
        let second = ClientRequest {
            op: "attach".into(),
            client_id: Some("owner-b".into()),
            protocol: Some(PROTOCOL_VERSION),
        };
        let resp = handle_request(&state, &second, &mut bound);
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("connection_already_bound"));
    }

    pub(super) fn parse_status_response_requires_ok_and_valid_payload() {
        let good = r#"{"ok":true,"op":"status","status":{"protocol":1,"version":"0.1.0","ready":true,"owners":1}}"#;
        assert!(parse_status_response(good).is_some());
        let bad_protocol =
            r#"{"ok":true,"op":"status","status":{"protocol":9,"version":"0.1.0","ready":true,"owners":0}}"#;
        assert!(parse_status_response(bad_protocol).is_none());
        assert!(parse_status_response(r#"{"ok":false,"op":"error"}"#).is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::unit_tests;

    #[test]
    fn unmanaged_by_default() {
        unit_tests::unmanaged_by_default();
    }

    #[test]
    fn managed_flag_and_env() {
        unit_tests::managed_flag_and_env();
    }

    #[test]
    fn parse_attach_request() {
        unit_tests::parse_attach_request();
    }

    #[test]
    fn grace_exit_only_after_interval() {
        unit_tests::grace_exit_only_after_interval();
    }

    #[test]
    fn initial_attachment_deadline() {
        unit_tests::initial_attachment_deadline();
    }

    #[test]
    fn client_cap_enforced() {
        unit_tests::client_cap_enforced();
    }

    #[test]
    fn validate_status_rejects_bad_protocol() {
        unit_tests::validate_status_rejects_bad_protocol();
    }

    #[test]
    fn parse_request_rejects_empty_and_oversized() {
        unit_tests::parse_request_rejects_empty_and_oversized();
    }

    #[test]
    fn release_not_bound_without_attach() {
        unit_tests::release_not_bound_without_attach();
    }

    #[test]
    fn release_not_bound_for_wrong_client_on_connection() {
        unit_tests::release_not_bound_for_wrong_client_on_connection();
    }

    #[test]
    fn multiple_owners_via_attach() {
        unit_tests::multiple_owners_via_attach();
    }

    #[test]
    fn attach_rejects_second_client_on_same_connection() {
        unit_tests::attach_rejects_second_client_on_same_connection();
    }

    #[test]
    fn parse_status_response_requires_ok_and_valid_payload() {
        unit_tests::parse_status_response_requires_ok_and_valid_payload();
    }
}

#[cfg(feature = "habitat-unit-tests")]
pub(crate) fn run_unit_tests() {
    unit_tests::unmanaged_by_default();
    unit_tests::managed_flag_and_env();
    unit_tests::parse_attach_request();
    unit_tests::grace_exit_only_after_interval();
    unit_tests::initial_attachment_deadline();
    unit_tests::client_cap_enforced();
    unit_tests::validate_status_rejects_bad_protocol();
    unit_tests::parse_request_rejects_empty_and_oversized();
    unit_tests::release_not_bound_without_attach();
    unit_tests::release_not_bound_for_wrong_client_on_connection();
    unit_tests::multiple_owners_via_attach();
    unit_tests::attach_rejects_second_client_on_same_connection();
    unit_tests::parse_status_response_requires_ok_and_valid_payload();
}
