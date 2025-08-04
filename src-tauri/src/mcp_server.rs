use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{command, Emitter};

// Struct to hold multiple MCP server processes
pub struct McpServerState {
    pub processes: Mutex<HashMap<String, Child>>,
}

// Start the MCP server as a child process
#[command]
pub fn start_mcp_server(
    server_id: String,
    command: Vec<String>,
    environment: Option<HashMap<String, String>>,
    cwd: Option<String>,
    state: tauri::State<'_, McpServerState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // Check if server with this ID is already running
    let mut processes_guard = match state.processes.lock() {
        Ok(guard) => guard,
        Err(_) => return Err("Failed to acquire lock on server state".to_string()),
    };

    if processes_guard.contains_key(&server_id) {
        return Ok(format!("MCP server '{}' is already running", server_id));
    }

    // Start Node.js process with the MCP server script
    match Command::new(&command[0])
        .args(&command[1..])
        .envs(environment.unwrap_or_default())
        .current_dir(cwd.unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            // Log server started
            let pid = child.id();

            // Get handles to stdout/stderr before moving child into state
            let stderr = child.stderr.take().unwrap();
            let stdout = child.stdout.take().unwrap();

            // Store the process in the state
            processes_guard.insert(server_id.clone(), child);

            // Drop the guard to release the lock
            drop(processes_guard);

            // Start a thread to log stdout
            let app_handle_stdout = app_handle.clone();
            let server_id_stdout = server_id.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    app_handle_stdout
                        .emit(
                            format!("mcp-stdout-{}", server_id_stdout).as_str(),
                            line.trim_end(),
                        )
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to emit event: {}", e);
                        });
                    line.clear();
                }
            });

            // Start a thread to log stderr
            let app_handle_stderr = app_handle.clone();
            let server_id_stderr = server_id.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    app_handle_stderr
                        .emit(
                            format!("mcp-stderr-{}", server_id_stderr).as_str(),
                            line.trim_end(),
                        )
                        .unwrap_or_else(|e| {
                            eprintln!("Failed to emit event: {}", e);
                        });
                    line.clear();
                }
            });

            Ok(format!(
                "MCP server '{}' started with PID: {}",
                server_id, pid
            ))
        }
        Err(e) => Err(format!("Failed to start MCP server '{}': {}", server_id, e)),
    }
}

// Stop the MCP server
#[command]
pub fn stop_mcp_server(
    server_id: String,
    state: tauri::State<'_, McpServerState>,
) -> Result<String, String> {
    let mut processes_guard = match state.processes.lock() {
        Ok(guard) => guard,
        Err(_) => return Err("Failed to acquire lock on server state".to_string()),
    };

    if let Some(mut process) = processes_guard.remove(&server_id) {
        match process.kill() {
            Ok(_) => Ok(format!("MCP server '{}' stopped", server_id)),
            Err(e) => {
                // Put the process back since we couldn't kill it
                processes_guard.insert(server_id.clone(), process);
                Err(format!("Failed to stop MCP server '{}': {}", server_id, e))
            }
        }
    } else {
        Ok(format!("MCP server '{}' was not running", server_id))
    }
}

// List all running MCP servers
#[command]
pub fn list_mcp_servers(state: tauri::State<'_, McpServerState>) -> Result<Vec<String>, String> {
    let processes_guard = match state.processes.lock() {
        Ok(guard) => guard,
        Err(_) => return Err("Failed to acquire lock on server state".to_string()),
    };

    let server_ids: Vec<String> = processes_guard.keys().cloned().collect();
    Ok(server_ids)
}

// Stop all MCP servers
#[command]
pub fn stop_all_mcp_servers(state: tauri::State<'_, McpServerState>) -> Result<String, String> {
    let mut processes_guard = match state.processes.lock() {
        Ok(guard) => guard,
        Err(_) => return Err("Failed to acquire lock on server state".to_string()),
    };

    let server_count = processes_guard.len();
    let mut stopped_count = 0;
    let mut failed_servers = Vec::new();

    // Kill all processes
    for (server_id, mut process) in processes_guard.drain() {
        match process.kill() {
            Ok(_) => {
                stopped_count += 1;
            }
            Err(e) => {
                failed_servers.push(format!("{}: {}", server_id, e));
            }
        }
    }

    if failed_servers.is_empty() {
        Ok(format!("Stopped {} MCP servers", stopped_count))
    } else {
        Err(format!(
            "Stopped {}/{} servers. Failed to stop: {}",
            stopped_count,
            server_count,
            failed_servers.join(", ")
        ))
    }
}

// Send message to MCP server's stdin
#[command]
pub fn send_to_mcp_server(
    server_id: String,
    message: String,
    state: tauri::State<'_, McpServerState>,
) -> Result<String, String> {
    let mut processes_guard = match state.processes.lock() {
        Ok(guard) => guard,
        Err(_) => return Err("Failed to acquire lock on server state".to_string()),
    };

    if let Some(ref mut process) = processes_guard.get_mut(&server_id) {
        if let Some(stdin) = process.stdin.as_mut() {
            // Add newline if the message doesn't end with one (common for JSON-RPC)
            let message_with_newline = if message.ends_with('\n') {
                message
            } else {
                format!("{}\n", message)
            };

            match stdin.write_all(message_with_newline.as_bytes()) {
                Ok(_) => {
                    // Flush to ensure the message is sent immediately
                    match stdin.flush() {
                        Ok(_) => Ok(format!("Message sent to MCP server '{}'", server_id)),
                        Err(e) => Err(format!(
                            "Failed to flush message to MCP server '{}': {}",
                            server_id, e
                        )),
                    }
                }
                Err(e) => Err(format!(
                    "Failed to send message to MCP server '{}': {}",
                    server_id, e
                )),
            }
        } else {
            Err(format!("Failed to get stdin of MCP server '{}'", server_id))
        }
    } else {
        Err(format!("MCP server '{}' not running", server_id))
    }
}
