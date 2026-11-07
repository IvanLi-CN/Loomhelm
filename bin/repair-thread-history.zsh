#!/bin/zsh
emulate -L zsh
set -euo pipefail
setopt NO_NOMATCH PIPE_FAIL

readonly SCRIPT_NAME=${0:t}
readonly CODEX_HOME_DIR=${CODEX_HOME:-$HOME/.codex}
readonly DB_PATH="$CODEX_HOME_DIR/thread_history_1.sqlite"
readonly LSOF_BIN=/usr/sbin/lsof
readonly PS_BIN=/bin/ps
readonly KILL_BIN=/bin/kill
readonly SLEEP_BIN=/bin/sleep

dry_run=0
force=0
kill_holders=0
sqlite_bin=""
log_file=""
backup_dir=""
source_mode=""

usage() {
  cat <<'EOF'
Usage:
  repair-thread-history.zsh [--dry-run] [--kill-holders] [--force]

Repairs the local Codex thread-history SQLite database after a
"database disk image is malformed" error.

Options:
  --dry-run  Inspect the database and report what would happen. No writes or
             process termination are performed.
  --kill-holders
             Permit terminating Codex/ChatGPT processes that still hold the
             database. Prefer closing the app yourself.
  --force    Allow repair even when the database passes integrity_check.
  --help     Show this help.

  The normal run requires a closed ChatGPT/Codex app unless --kill-holders is
  explicitly provided. Original files remain in a timestamped backup.
EOF
}

die() {
  print -r -- "ERROR: $*" >&2
  exit 1
}

log() {
  local line
  line="[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*"
  print -r -- "$line"
  if [[ -n "$log_file" ]]; then
    print -r -- "$line" >> "$log_file"
  fi
}

choose_sqlite() {
  local candidate
  local -a candidates
  candidates=(
    "${SQLITE3:-}"
    "$HOME/miniconda3/bin/sqlite3"
    "/opt/homebrew/bin/sqlite3"
    "/usr/local/bin/sqlite3"
    "/usr/bin/sqlite3"
    "$(whence -p sqlite3 2>/dev/null || true)"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      if "$candidate" ':memory:' '.help recover' >/dev/null 2>&1; then
        print -r -- "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

collect_holders() {
  local pid
  local raw_pids
  holder_pids=()
  raw_pids=$("$LSOF_BIN" -t "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm" 2>/dev/null | /usr/bin/sort -u || true)
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && holder_pids+=("$pid")
  done <<< "$raw_pids"
}

process_command() {
  "$PS_BIN" -p "$1" -o command= 2>/dev/null | /usr/bin/sed 's/[[:space:]]\+/ /g' || true
}

is_codex_process() {
  local command_line
  command_line=$(process_command "$1")
  [[ "$command_line" == *codex* || "$command_line" == *Codex* || "$command_line" == *ChatGPT* ]]
}

print_holders() {
  local pid
  for pid in $holder_pids; do
    print -r -- "  $($PS_BIN -p "$pid" -o pid=,stat=,comm= 2>/dev/null | /usr/bin/sed 's/[[:space:]]\+/ /g')"
  done
}

stop_holders() {
  local pid
  local attempt
  local blocked=""

  collect_holders
  (( ${#holder_pids} == 0 )) && return 0

  log "Database holders detected:"
  print_holders
  if (( kill_holders == 0 )); then
    die "database is in use; close ChatGPT/Codex and rerun (or explicitly add --kill-holders)"
  fi
  for pid in $holder_pids; do
    if ! is_codex_process "$pid"; then
      blocked+=" $pid"
    fi
  done
  if [[ -n "$blocked" ]]; then
    die "refusing to terminate non-Codex database holders:$blocked"
  fi
  (( dry_run == 1 )) && { log "Dry run: would send TERM to database holders."; return 0; }

  for attempt in {1..3}; do
    collect_holders
    (( ${#holder_pids} == 0 )) && return 0
    for pid in $holder_pids; do
      "$KILL_BIN" -TERM "$pid" 2>/dev/null || true
    done
    "$SLEEP_BIN" 2
  done

  collect_holders
  if (( ${#holder_pids} > 0 )); then
    log "Some Codex holders did not exit after TERM; sending KILL."
    for pid in $holder_pids; do
      "$KILL_BIN" -KILL "$pid" 2>/dev/null || true
    done
    "$SLEEP_BIN" 2
  fi
  collect_holders
  (( ${#holder_pids} == 0 )) || die "database is still held after termination attempts"
}

copy_if_present() {
  local source_path=$1
  local target_path=$2
  [[ -e "$source_path" ]] || return 0
  /bin/cp -c -p "$source_path" "$target_path" 2>/dev/null || /bin/cp -p "$source_path" "$target_path"
}

move_if_present() {
  local source_path=$1
  local target_path=$2
  [[ -e "$source_path" ]] || return 0
  /bin/mv "$source_path" "$target_path"
}

sqlite_scalar() {
  "$sqlite_bin" -readonly "$1" "$2" 2>/dev/null
}

validate_candidate() {
  local candidate=$1
  local integrity
  local schema
  local table
  local item_count
  local turn_count
  local projection_count
  local source_item_count
  local source_turn_count

  integrity=$("$sqlite_bin" -readonly "$candidate" 'PRAGMA integrity_check;' 2>&1) || {
    log "Candidate integrity_check failed:"
    print -r -- "$integrity" | /usr/bin/sed -n '1,30p'
    return 1
  }
  [[ "$integrity" == "ok" ]] || {
    log "Candidate integrity_check returned: $integrity"
    return 1
  }

  schema=$("$sqlite_bin" -readonly "$candidate" "SELECT name FROM sqlite_master WHERE type='table';")
  for table in thread_items thread_turns thread_history_projection_state; do
    print -r -- "$schema" | /usr/bin/grep -Fxq "$table" || {
      log "Candidate is missing required table: $table"
      return 1
    }
  done

  item_count=$(sqlite_scalar "$candidate" 'SELECT count(*) FROM thread_items;')
  turn_count=$(sqlite_scalar "$candidate" 'SELECT count(*) FROM thread_turns;')
  projection_count=$(sqlite_scalar "$candidate" 'SELECT count(*) FROM thread_history_projection_state;')
  [[ "$item_count" == <-> ]] || {
    log "Candidate row count is invalid: items=$item_count"
    return 1
  }
  [[ "$turn_count" == <-> ]] || {
    log "Candidate row count is invalid: turns=$turn_count"
    return 1
  }
  [[ "$projection_count" == <-> ]] || {
    log "Candidate row counts are invalid: items=$item_count turns=$turn_count projection=$projection_count"
    return 1
  }
  (( item_count > 0 && turn_count > 0 )) || {
    log "Candidate contains no usable thread history: items=$item_count turns=$turn_count"
    return 1
  }

  source_item_count=$(sqlite_scalar "$DB_PATH" 'SELECT count(*) FROM thread_items;' || true)
  source_turn_count=$(sqlite_scalar "$DB_PATH" 'SELECT count(*) FROM thread_turns;' || true)
  if [[ "$source_item_count" == <-> && "$source_item_count" -gt 0 && "$force" -eq 0 ]]; then
    (( item_count >= source_item_count / 2 )) || {
      log "Candidate item count is less than half of readable source rows: source=$source_item_count candidate=$item_count"
      return 1
    }
  fi
  if [[ "$source_turn_count" == <-> && "$source_turn_count" -gt 0 && "$force" -eq 0 ]]; then
    (( turn_count >= source_turn_count / 2 )) || {
      log "Candidate turn count is less than half of readable source rows: source=$source_turn_count candidate=$turn_count"
      return 1
    }
  fi

  log "Candidate validated: items=$item_count turns=$turn_count projection=$projection_count integrity=ok"
}

rollback_install() {
  local retired_main=$1
  local retired_wal=$2
  local retired_shm=$3
  local invalid_main=$4

  collect_holders
  (( ${#holder_pids} == 0 )) || return 1
  move_if_present "$DB_PATH" "$invalid_main"
  move_if_present "${DB_PATH}-wal" "${invalid_main}-wal"
  move_if_present "${DB_PATH}-shm" "${invalid_main}-shm"
  move_if_present "$retired_main" "$DB_PATH"
  move_if_present "$retired_wal" "${DB_PATH}-wal"
  move_if_present "$retired_shm" "${DB_PATH}-shm"
  return 0
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --kill-holders) kill_holders=1 ;;
    --force) force=1; kill_holders=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

[[ -f "$DB_PATH" ]] || die "thread history database not found: $DB_PATH"
sqlite_bin=$(choose_sqlite) || die "sqlite3 with the .recover command was not found"

source_size=$(/usr/bin/stat -f %z "$DB_PATH")
available_bytes=$(/bin/df -Pk "$CODEX_HOME_DIR" | /usr/bin/awk 'NR==2 {print $4 * 1024}')
(( available_bytes >= source_size * 3 )) || die "insufficient free space for a safe recovery (need about $((source_size * 3 / 1073741824)) GiB free; available $((available_bytes / 1073741824)) GiB)"

integrity_status=0
integrity_output=$("$sqlite_bin" -readonly "$DB_PATH" 'PRAGMA integrity_check;' 2>&1) || integrity_status=$?
if (( integrity_status == 0 )) && [[ "$integrity_output" == "ok" && "$force" -eq 0 ]]; then
  log "No repair needed: current database passes integrity_check."
  collect_holders
  if (( ${#holder_pids} > 0 )); then
    log "Current database holders:"
    print_holders
  fi
  exit 0
fi

if (( integrity_status != 0 )) || [[ "$integrity_output" != "ok" ]]; then
  log "Current database is malformed or unreadable; recovery is required."
  print -r -- "$integrity_output" | /usr/bin/sed -n '1,20p'
else
  log "--force requested: rebuilding a database that currently passes integrity_check."
fi

collect_holders
if (( dry_run == 1 )); then
  log "Dry run: no files will be changed and no processes will be terminated."
  if (( ${#holder_pids} > 0 )); then
    log "Database holders:"
    print_holders
  fi
  log "Would create a timestamped backup, stream SQLite .recover into a candidate, validate it, and atomically replace the database."
  exit 0
fi

stop_holders

stamp=$(/bin/date +%Y%m%dT%H%M%S)
backup_dir="$CODEX_HOME_DIR/db-backups/thread-history-repair-$stamp-$$"
mkdir -p "$backup_dir/original" "$backup_dir/retired"
log_file="$backup_dir/repair.log"
log "Starting thread-history recovery with sqlite=$sqlite_bin"

source_mode=$(/usr/bin/stat -f %Lp "$DB_PATH")
copy_if_present "$DB_PATH" "$backup_dir/original/thread_history_1.sqlite"
copy_if_present "${DB_PATH}-wal" "$backup_dir/original/thread_history_1.sqlite-wal"
copy_if_present "${DB_PATH}-shm" "$backup_dir/original/thread_history_1.sqlite-shm"

/usr/bin/shasum -a 256 "$backup_dir/original"/* > "$backup_dir/original/SHA256SUMS"

raw_db="$backup_dir/original/thread_history_1.sqlite"
candidate_db="$backup_dir/thread_history_recovered.sqlite"

log "Streaming recoverable rows with SQLite .recover"
if ! {
  {
    print -r -- '.bail on'
    print -r -- 'PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;'
    "$sqlite_bin" "$raw_db" '.recover --ignore-freelist' 2> "$backup_dir/recovery.stderr"
  } | "$sqlite_bin" "$candidate_db" > "$backup_dir/import.stdout" 2> "$backup_dir/import.stderr"
}; then
  die "SQLite recovery import failed; candidate was retained at $candidate_db"
fi

validate_candidate "$candidate_db" || die "candidate validation failed; original database was retained"

stop_holders
retired_main="$backup_dir/retired/thread_history_1.sqlite"
retired_wal="${retired_main}-wal"
retired_shm="${retired_main}-shm"
invalid_main="$backup_dir/retired/thread_history_1.sqlite.invalid-install"

log "Installing validated candidate atomically"
move_if_present "$DB_PATH" "$retired_main"
move_if_present "${DB_PATH}-wal" "$retired_wal"
move_if_present "${DB_PATH}-shm" "$retired_shm"
if ! /bin/mv "$candidate_db" "$DB_PATH"; then
  rollback_install "$retired_main" "$retired_wal" "$retired_shm" "$invalid_main" || true
  die "candidate installation failed; rollback was attempted"
fi
/bin/chmod "$source_mode" "$DB_PATH"

installed_integrity=$("$sqlite_bin" -readonly "$DB_PATH" 'PRAGMA integrity_check;' 2>&1) || true
if [[ "$installed_integrity" != "ok" ]]; then
  log "Installed database failed integrity_check; attempting rollback"
  rollback_install "$retired_main" "$retired_wal" "$retired_shm" "$invalid_main" || die "rollback failed; inspect $backup_dir"
  die "installed database failed integrity_check; original database restored"
fi

installed_items=$(sqlite_scalar "$DB_PATH" 'SELECT count(*) FROM thread_items;')
installed_turns=$(sqlite_scalar "$DB_PATH" 'SELECT count(*) FROM thread_turns;')
installed_projection=$(sqlite_scalar "$DB_PATH" 'SELECT count(*) FROM thread_history_projection_state;')
cat > "$backup_dir/status.txt" <<EOF
status=activated
database=$DB_PATH
installed_at=$(/bin/date '+%Y-%m-%d %H:%M:%S %z')
integrity_check=ok
thread_items=$installed_items
thread_turns=$installed_turns
thread_history_projection_state=$installed_projection
original_snapshot=$backup_dir/original/thread_history_1.sqlite
retired_original=$retired_main
EOF

/usr/bin/shasum -a 256 "$DB_PATH" > "$backup_dir/installed-SHA256SUMS"
log "Recovery complete: integrity_check=ok items=$installed_items turns=$installed_turns"
log "Backup and rollback files: $backup_dir"
log "Reopen ChatGPT/Codex after this command exits."
