#!/bin/bash
# Claude Code Status Line - Focus on essentials
# Features: Current model, working directory, context usage, git branch
STATUSLINE_VERSION="2.0.0"

input=$(cat)

# ---- check jq availability ----
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=1
fi

# Get the directory where this statusline script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/statusline.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ---- logging (disabled for cleaner performance) ----
# Uncomment for debugging:
# {
#   echo "[$TIMESTAMP] Status line triggered (v${STATUSLINE_VERSION})"
#   echo "[$TIMESTAMP] Input:"
#   if [ "$HAS_JQ" -eq 1 ]; then
#     echo "$input" | jq . 2>/dev/null || echo "$input"
#   else
#     echo "$input"
#   fi
#   echo "---"
# } >> "$LOG_FILE" 2>/dev/null

# ---- color helpers (force colors for Claude Code) ----
use_color=1
[ -n "$NO_COLOR" ] && use_color=0

C() { if [ "$use_color" -eq 1 ]; then printf '\033[%sm' "$1"; fi; }
RST() { if [ "$use_color" -eq 1 ]; then printf '\033[0m'; fi; }

# ---- modern sleek colors ----
dir_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;117m'; fi; }    # sky blue
model_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;147m'; fi; }  # light purple  
version_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;180m'; fi; } # soft yellow
cc_version_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;249m'; fi; } # light gray
style_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;245m'; fi; } # gray
rst() { if [ "$use_color" -eq 1 ]; then printf '\033[0m'; fi; }

# ---- time helpers ----
to_epoch() {
  ts="$1"
  if command -v gdate >/dev/null 2>&1; then gdate -d "$ts" +%s 2>/dev/null && return; fi
  date -u -j -f "%Y-%m-%dT%H:%M:%S%z" "${ts/Z/+0000}" +%s 2>/dev/null && return
  python3 - "$ts" <<'PY' 2>/dev/null
import sys, datetime
s=sys.argv[1].replace('Z','+00:00')
print(int(datetime.datetime.fromisoformat(s).timestamp()))
PY
}

fmt_time_hm() {
  epoch="$1"
  if date -r 0 +%s >/dev/null 2>&1; then date -r "$epoch" +"%H:%M"; else date -d "@$epoch" +"%H:%M"; fi
}

progress_bar() {
  pct="${1:-0}"; width="${2:-10}"
  [[ "$pct" =~ ^[0-9]+$ ]] || pct=0; ((pct<0))&&pct=0; ((pct>100))&&pct=100
  filled=$(( pct * width / 100 )); empty=$(( width - filled ))
  printf '%*s' "$filled" '' | tr ' ' '='
  printf '%*s' "$empty" '' | tr ' ' '-'
}

# git utilities
num_or_zero() { v="$1"; [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0; }

# ---- JSON extraction utilities ----
# Pure bash JSON value extractor (fallback when jq not available)
extract_json_string() {
  local json="$1"
  local key="$2"
  local default="${3:-}"
  
  # For nested keys like workspace.current_dir, get the last part
  local field="${key##*.}"
  field="${field%% *}"  # Remove any jq operators
  
  # Try to extract string value (quoted)
  local value=$(echo "$json" | grep -o "\"\${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/')
  
  # Convert escaped backslashes to forward slashes for Windows paths
  if [ -n "$value" ]; then
    value=$(echo "$value" | sed 's/\\\\/\//g')
  fi
  
  # If no string value found, try to extract number value (unquoted)
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    value=$(echo "$json" | grep -o "\"\${field}\"[[:space:]]*:[[:space:]]*[0-9.]\+" | head -1 | sed 's/.*:[[:space:]]*\([0-9.]\+\).*/\1/')
  fi
  
  # Return value or default
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    echo "$value"
  else
    echo "$default"
  fi
}

# ---- basics ----
if [ "$HAS_JQ" -eq 1 ]; then
  current_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "unknown"' 2>/dev/null | sed "s|^$HOME|~|g")
  model_name=$(echo "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null)
  model_version=$(echo "$input" | jq -r '.model.version // ""' 2>/dev/null)
  session_id=$(echo "$input" | jq -r '.session_id // ""' 2>/dev/null)
  cc_version=$(echo "$input" | jq -r '.version // ""' 2>/dev/null)
  output_style=$(echo "$input" | jq -r '.output_style.name // ""' 2>/dev/null)
else
  # Bash fallback for JSON extraction
  # Extract current_dir from workspace object - look for the pattern workspace":{"current_dir":"..."}
  current_dir=$(echo "$input" | grep -o '"workspace"[[:space:]]*:[[:space:]]*{[^}]*"current_dir"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"current_dir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | sed 's/\\\\/\//g')
  
  # Fall back to cwd if workspace extraction failed
  if [ -z "$current_dir" ] || [ "$current_dir" = "null" ]; then
    current_dir=$(echo "$input" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | sed 's/\\\\/\//g')
  fi
  
  # Fallback to unknown if all extraction failed
  [ -z "$current_dir" ] && current_dir="unknown"
  current_dir=$(echo "$current_dir" | sed "s|^$HOME|~|g")
  
  # Extract model name from nested model object
  model_name=$(echo "$input" | grep -o '"model"[[:space:]]*:[[:space:]]*{[^}]*"display_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  [ -z "$model_name" ] && model_name="Claude"
  # Model version is in the model ID, not a separate field  
  model_version=""  # Not available in Claude Code JSON
  session_id=$(extract_json_string "$input" "session_id" "")
  # CC version is at the root level
  cc_version=$(echo "$input" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  # Output style is nested
  output_style=$(echo "$input" | grep -o '"output_style"[[:space:]]*:[[:space:]]*{[^}]*"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

# ---- git colors ----
git_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;150m'; fi; }  # soft green
rst() { if [ "$use_color" -eq 1 ]; then printf '\033[0m'; fi; }

# ---- git ----
git_branch=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  git_branch=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
fi

# ---- context window calculation (native) ----
context_pct=""
context_remaining_pct=""
context_color() { if [ "$use_color" -eq 1 ]; then printf '\033[1;37m'; fi; }  # default white

if [ "$HAS_JQ" -eq 1 ]; then
  # Get context window size and current usage from native Claude Code input
  CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 200000' 2>/dev/null)
  USAGE=$(echo "$input" | jq '.context_window.current_usage' 2>/dev/null)

  if [ "$USAGE" != "null" ] && [ -n "$USAGE" ]; then
    # Calculate current context from current_usage fields
    # Formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
    CURRENT_TOKENS=$(echo "$USAGE" | jq '(.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' 2>/dev/null)

    if [ -n "$CURRENT_TOKENS" ] && [ "$CURRENT_TOKENS" -gt 0 ] 2>/dev/null; then
      context_used_pct=$(( CURRENT_TOKENS * 100 / CONTEXT_SIZE ))
      context_remaining_pct=$(( 100 - context_used_pct ))
      # Clamp to valid range
      (( context_remaining_pct < 0 )) && context_remaining_pct=0
      (( context_remaining_pct > 100 )) && context_remaining_pct=100

      # Set color based on remaining percentage
      if [ "$context_remaining_pct" -le 20 ]; then
        context_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;203m'; fi; }  # coral red
      elif [ "$context_remaining_pct" -le 40 ]; then
        context_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;215m'; fi; }  # peach
      else
        context_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;158m'; fi; }  # mint green
      fi

      context_pct="${context_remaining_pct}%"
    fi
  fi
fi

# ---- usage colors ----
usage_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;189m'; fi; }  # lavender
cost_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;222m'; fi; }   # light gold
burn_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;220m'; fi; }   # bright gold
session_color() { 
  rem_pct=$(( 100 - session_pct ))
  if   (( rem_pct <= 10 )); then SCLR='38;5;210'  # light pink
  elif (( rem_pct <= 25 )); then SCLR='38;5;228'  # light yellow  
  else                          SCLR='38;5;194'; fi  # light green
  if [ "$use_color" -eq 1 ]; then printf '\033[%sm' "$SCLR"; fi
}

# ---- cost and usage extraction ----
session_txt=""; session_pct=0; session_bar=""
cost_usd=""; cost_per_hour=""; tpm=""; tot_tokens=""

# Extract cost and token data from Claude Code's native input
if [ "$HAS_JQ" -eq 1 ]; then
  # Cost data
  cost_usd=$(echo "$input" | jq -r '.cost.total_cost_usd // empty' 2>/dev/null)
  total_duration_ms=$(echo "$input" | jq -r '.cost.total_duration_ms // empty' 2>/dev/null)

  # Calculate burn rate ($/hour) from cost and duration
  if [ -n "$cost_usd" ] && [ -n "$total_duration_ms" ] && [ "$total_duration_ms" -gt 0 ]; then
    cost_per_hour=$(echo "$cost_usd $total_duration_ms" | awk '{printf "%.2f", $1 * 3600000 / $2}')
  fi

  # Token data from native context_window (no ccusage needed)
  input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0' 2>/dev/null)
  output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0' 2>/dev/null)

  if [ "$input_tokens" != "null" ] && [ "$output_tokens" != "null" ]; then
    tot_tokens=$(( input_tokens + output_tokens ))
    [ "$tot_tokens" -eq 0 ] && tot_tokens=""
  fi

  # Calculate tokens per minute from native data
  if [ -n "$tot_tokens" ] && [ -n "$total_duration_ms" ] && [ "$total_duration_ms" -gt 0 ]; then
    # Convert ms to minutes and calculate rate
    tpm=$(echo "$tot_tokens $total_duration_ms" | awk '{if ($2 > 0) printf "%.0f", $1 * 60000 / $2; else print ""}')
  fi
else
  # Bash fallback for cost extraction
  cost_usd=$(echo "$input" | grep -o '"total_cost_usd"[[:space:]]*:[[:space:]]*[0-9.]*' | sed 's/.*:[[:space:]]*\([0-9.]*\).*/\1/')
  total_duration_ms=$(echo "$input" | grep -o '"total_duration_ms"[[:space:]]*:[[:space:]]*[0-9]*' | sed 's/.*:[[:space:]]*\([0-9]*\).*/\1/')

  # Calculate burn rate ($/hour) from cost and duration
  if [ -n "$cost_usd" ] && [ -n "$total_duration_ms" ] && [ "$total_duration_ms" -gt 0 ]; then
    cost_per_hour=$(echo "$cost_usd $total_duration_ms" | awk '{printf "%.2f", $1 * 3600000 / $2}')
  fi

  # Token data from native context_window (bash fallback)
  input_tokens=$(echo "$input" | grep -o '"total_input_tokens"[[:space:]]*:[[:space:]]*[0-9]*' | sed 's/.*:[[:space:]]*\([0-9]*\).*/\1/')
  output_tokens=$(echo "$input" | grep -o '"total_output_tokens"[[:space:]]*:[[:space:]]*[0-9]*' | sed 's/.*:[[:space:]]*\([0-9]*\).*/\1/')

  if [ -n "$input_tokens" ] && [ -n "$output_tokens" ]; then
    tot_tokens=$(( input_tokens + output_tokens ))
    [ "$tot_tokens" -eq 0 ] && tot_tokens=""
  fi

  # Calculate tokens per minute from native data
  if [ -n "$tot_tokens" ] && [ -n "$total_duration_ms" ] && [ "$total_duration_ms" -gt 0 ]; then
    tpm=$(echo "$tot_tokens $total_duration_ms" | awk '{if ($2 > 0) printf "%.0f", $1 * 60000 / $2; else print ""}')
  fi
fi

# Session reset time requires ccusage (only feature that needs external tool)
if command -v ccusage >/dev/null 2>&1 && [ "$HAS_JQ" -eq 1 ]; then
  blocks_output=""

  # Try ccusage with timeout
  if command -v timeout >/dev/null 2>&1; then
    blocks_output=$(timeout 5s ccusage blocks --json 2>/dev/null)
  elif command -v gtimeout >/dev/null 2>&1; then
    blocks_output=$(gtimeout 5s ccusage blocks --json 2>/dev/null)
  else
    blocks_output=$(ccusage blocks --json 2>/dev/null)
  fi

  if [ -n "$blocks_output" ]; then
    active_block=$(echo "$blocks_output" | jq -c '.blocks[] | select(.isActive == true)' 2>/dev/null | head -n1)
    if [ -n "$active_block" ]; then
      # Session time calculation from ccusage
      reset_time_str=$(echo "$active_block" | jq -r '.usageLimitResetTime // .endTime // empty')
      start_time_str=$(echo "$active_block" | jq -r '.startTime // empty')

      if [ -n "$reset_time_str" ] && [ -n "$start_time_str" ]; then
        start_sec=$(to_epoch "$start_time_str"); end_sec=$(to_epoch "$reset_time_str"); now_sec=$(date +%s)
        total=$(( end_sec - start_sec )); (( total<1 )) && total=1
        elapsed=$(( now_sec - start_sec )); (( elapsed<0 ))&&elapsed=0; (( elapsed>total ))&&elapsed=$total
        session_pct=$(( elapsed * 100 / total ))
        remaining=$(( end_sec - now_sec )); (( remaining<0 )) && remaining=0
        rh=$(( remaining / 3600 )); rm=$(( (remaining % 3600) / 60 ))
        end_hm=$(fmt_time_hm "$end_sec")
        session_txt="$(printf '%dh %dm until reset at %s (%d%%)' "$rh" "$rm" "$end_hm" "$session_pct")"
        session_bar=$(progress_bar "$session_pct" 10)
      fi
    fi
  fi
fi

# ---- log extracted data (disabled for performance) ----
# Uncomment for debugging:
# {
#   echo "[$TIMESTAMP] Extracted: dir=${current_dir:-}, model=${model_name:-}, git=${git_branch:-}, context=${context_pct:-}"
# } >> "$LOG_FILE" 2>/dev/null

# ---- rate limit extraction ----
rate_5h_pct=""; rate_7d_pct=""; rate_5h_reset=""
rate_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;158m'; fi; }  # mint green default

if [ "$HAS_JQ" -eq 1 ]; then
  rate_5h_pct=$(echo "$input" | jq -r '.rate_limits // {} | .["5h"] // {} | .used_percentage // empty' 2>/dev/null)
  rate_7d_pct=$(echo "$input" | jq -r '.rate_limits // {} | .["7d"] // {} | .used_percentage // empty' 2>/dev/null)
  effort_level=$(echo "$input" | jq -r '.effort.level // empty' 2>/dev/null)
  rate_5h_reset=$(echo "$input" | jq -r '.rate_limits // {} | .["5h"] // {} | .resets_at // empty' 2>/dev/null)

  # Color based on 5h usage (most likely to hit)
  if [ -n "$rate_5h_pct" ]; then
    rate_int=${rate_5h_pct%.*}
    if [ "$rate_int" -ge 80 ] 2>/dev/null; then
      rate_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;203m'; fi; }  # coral red
    elif [ "$rate_int" -ge 60 ] 2>/dev/null; then
      rate_color() { if [ "$use_color" -eq 1 ]; then printf '\033[38;5;215m'; fi; }  # peach
    fi
  fi
fi

# ---- render statusline ----
# FOCUSED LAYOUT: Model | Directory | Git | Context | Rate

# Line 1: Model and Directory
printf '🤖 %s%s%s' "$(model_color)" "$model_name" "$(rst)"
printf '  📁 %s%s%s' "$(dir_color)" "$current_dir" "$(rst)"

# Add git branch if available
if [ -n "$git_branch" ]; then
  printf '  🌿 %s%s%s' "$(git_color)" "$git_branch" "$(rst)"
fi

# Line 2: Context window usage (most important for long sessions)
printf '\n'
if [ -n "$context_pct" ]; then
  context_bar=$(progress_bar "$context_remaining_pct" 20)
  printf '🧠 %sContext: %s remaining [%s]%s' "$(context_color)" "$context_pct" "$context_bar" "$(rst)"
else
  printf '🧠 %sContext: Initializing...%s' "$(context_color)" "$(rst)"
fi

# Effort level (added 2026-09-08: a silent medium fallback stayed invisible for weeks — P42)
if [ -n "$effort_level" ]; then
  printf '  🎚 %seffort:%s%s' "$(model_color)" "$effort_level" "$(rst)"
fi

# Rate limit usage (if available)
if [ -n "$rate_5h_pct" ]; then
  printf '  ⚡ %sRate: %s%% of 5h' "$(rate_color)" "$rate_5h_pct"
  if [ -n "$rate_5h_reset" ]; then
    reset_hm=""
    reset_epoch=$(to_epoch "$rate_5h_reset" 2>/dev/null)
    if [ -n "$reset_epoch" ]; then
      reset_hm=$(fmt_time_hm "$reset_epoch" 2>/dev/null)
    fi
    if [ -n "$reset_hm" ]; then
      printf ' (resets %s)' "$reset_hm"
    fi
  fi
  if [ -n "$rate_7d_pct" ]; then
    printf ' | %s%% of 7d' "$rate_7d_pct"
  fi
  printf '%s' "$(rst)"
fi

printf '\n'
