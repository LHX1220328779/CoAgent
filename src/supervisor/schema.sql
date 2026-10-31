PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, repo TEXT NOT NULL,
 status TEXT NOT NULL, priority INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id,depends_on), CHECK(task_id != depends_on));
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, role TEXT NOT NULL, directory TEXT NOT NULL, model TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'idle', UNIQUE(role,directory));
CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS worktrees (task_id TEXT PRIMARY KEY REFERENCES tasks(id), directory TEXT NOT NULL UNIQUE, repo TEXT NOT NULL, branch TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, adapter TEXT NOT NULL, latency_ms INTEGER NOT NULL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, estimated INTEGER, cost REAL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduler_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id,id);
CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(status,priority,created_at);
CREATE TABLE IF NOT EXISTS task_agent_sessions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), runtime_id TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL, directory TEXT NOT NULL, model TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
 UNIQUE(task_id,role)
);
CREATE TABLE IF NOT EXISTS arena_catalog (
 id TEXT PRIMARY KEY, account_email TEXT NOT NULL, title TEXT NOT NULL, available INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS arena_leases (
 arena_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
 runtime_id TEXT NOT NULL UNIQUE, reserved_at INTEGER NOT NULL, UNIQUE(task_id,role)
);

CREATE TABLE IF NOT EXISTS arena_successful_sessions (
 arena_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), last_success_at INTEGER NOT NULL
);
