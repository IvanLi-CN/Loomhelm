#!/usr/bin/env bash
set -euo pipefail

BASE_REF=""
SPEC_FREE=0
ADR_REFS="${ADR_REFS:-}"
declare -a SPEC_PATHS=()
declare -a CHANGED_FILES=()
declare -a WORKTREE_CHANGED_FILES=()
declare -a DELETED_FILES=()
declare -a RENAME_OLD_FILES=()
declare -a RENAME_NEW_FILES=()
declare -a MERGE_COMMITS=()
declare -a RELATED_ADR_SECTION_REQUIRED_SPECS=()
declare -a related_adr_stream_paths=()
REPO_ROOT=""
INVOCATION_CWD=""
CURRENT_BRANCH=""
strict_spec_error=""
PARSE_STATUS=""
PARSE_PATH1=""
PARSE_PATH2=""
declare -a commit_spec_touched_flags=()
declare -a normalized_spec_roots=()

to_evidence_entry() {
  local path="$1"
  local sha=""

  if [[ -f "$path" ]]; then
    sha=$(git hash-object "$path" 2>/dev/null || true)
  elif sha=$(git rev-parse --verify "HEAD:${path}" 2>/dev/null); then
    :
  fi

  if [[ -z "$sha" ]]; then
    sha="unknown"
  fi

  printf '%s@%s' "$path" "$sha"
}

evidence_csv() {
  local out=""
  local path
  for path in "$@"; do
    [[ -z "$path" ]] && continue
    out="${out}$(to_evidence_entry "$path"),"
  done
  out="${out%,}"
  printf '%s' "$out"
}

path_counts_as_spec_sync() {
  local path="$1"
  local root="$2"
  local associated_spec="$3"
  local rel=""
  [[ -n "$root" ]] || return 1
  [[ "$path" == "$root/"* ]] || return 1

  rel="${path#"$root"/}"
  case "$rel" in
    SPEC.md|IMPLEMENTATION.md|HISTORY.md)
      return 0
      ;;
    PLAN.md)
      case "$associated_spec" in
        docs/plan/*/PLAN.md|docs/specs/*/PLAN.md)
          return 0
          ;;
      esac
      ;;
    contracts/*)
      return 0
      ;;
  esac

  return 1
}

add_spec_evidence() {
  local path="$1"
  local existing
  [[ -z "$path" ]] && return 0

  for existing in "${spec_evidence[@]-}"; do
    if [[ "$existing" == "$path" ]]; then
      return 0
    fi
  done

  spec_evidence+=("$path")
}

validate_frozen_adr_refs() {
  local binding=""
  local path=""
  local expected_blob=""
  local actual_blob=""
  local index_blob=""
  local index_entry=""
  local index_content=""
  local previous_path=""
  local requested_spec=""
  local normalized_spec=""
  local candidate_path=""
  local require_index_section=0
  local allow_index_legacy_list_none=0
  local -a bindings=()
  local -a frozen_paths=()
  local -a candidate_paths=()
  local -a index_candidate_paths=()
  local -a all_candidate_paths=()
  local -a all_index_candidate_paths=()
  local -a canonical_candidate_paths=()
  local -a canonical_index_candidate_paths=()

  related_adr_error=""
  [[ -z "$ADR_REFS" ]] && return 0
  if [[ "$ADR_REFS" != "none" && ( "$ADR_REFS" == ,* || "$ADR_REFS" == *, || "$ADR_REFS" == *",,"* ) ]]; then
    related_adr_error="invalid frozen ADR refs: empty entry"
    return 1
  fi
  if [[ "$ADR_REFS" != "none" ]]; then
    IFS=',' read -r -a bindings <<<"$ADR_REFS"
  fi
  for binding in "${bindings[@]-}"; do
    [[ -n "$binding" ]] || continue
    if [[ ! "$binding" =~ ^(docs/adr/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md)@([0-9a-f]{40})$ ]]; then
      related_adr_error="invalid frozen ADR ref"
      return 1
    fi
    path="${BASH_REMATCH[1]}"
    expected_blob="${BASH_REMATCH[3]}"
    if [[ -n "$previous_path" ]] && [[ "$path" < "$previous_path" || "$path" == "$previous_path" ]]; then
      related_adr_error="invalid frozen ADR refs: paths must be unique and sorted"
      return 1
    fi
    previous_path="$path"
    frozen_paths+=("$path")
    if [[ ! -f "$path" || -L "$path" ]]; then
      related_adr_error="frozen ADR ref is not a regular candidate file: ${path}"
      return 1
    fi
    index_entry="$(git ls-files -s -- "$path")"
    if [[ ! "$index_entry" =~ ^(100644|100755)[[:space:]]+([0-9a-f]{40})[[:space:]]+0[[:space:]] ]]; then
      related_adr_error="frozen ADR ref is not a regular index file: ${path}"
      return 1
    fi
    index_blob="${BASH_REMATCH[2]}"
    if [[ "$index_blob" != "$expected_blob" ]]; then
      related_adr_error="frozen ADR ref drifted in index: ${path}"
      return 1
    fi
    actual_blob="$(git hash-object "$path" 2>/dev/null || true)"
    if [[ "$actual_blob" != "$expected_blob" ]]; then
      related_adr_error="frozen ADR ref drifted: ${path}"
      return 1
    fi
  done

  for requested_spec in "${SPEC_PATHS[@]-}"; do
    if normalized_spec="$(resolve_associated_spec_path "$(normalize_to_repo_rel "$requested_spec")")"; then
      :
    else
      continue
    fi
    if [[ ! -f "$normalized_spec" || -L "$normalized_spec" ]]; then
      related_adr_error="frozen ADR membership has no regular candidate Spec: ${normalized_spec}"
      return 1
    fi
    candidate_paths=()
    while IFS= read -r candidate_path; do
      [[ -z "$candidate_path" ]] || candidate_paths+=("$candidate_path")
    done < <(related_adr_paths_for_spec "$normalized_spec")
    all_candidate_paths+=("${candidate_paths[@]-}")

    # A staged SPEC.md is part of the candidate, so it must bind the same ADR list.
    index_entry="$(git ls-files -s -- "$normalized_spec")"
    if [[ -n "$index_entry" ]]; then
      if [[ ! "$index_entry" =~ ^100644[[:space:]]+[0-9a-f]{40}[[:space:]]+0[[:space:]] ]]; then
        related_adr_error="frozen ADR membership has no regular index Spec: ${normalized_spec}"
        return 1
      fi
    if ! index_content="$(git show ":${normalized_spec}" 2>/dev/null)"; then
      related_adr_error="frozen ADR membership cannot read index Spec: ${normalized_spec}"
      return 1
    fi
    require_index_section=0
    allow_index_legacy_list_none=0
    if source_path_requires_related_adrs "$requested_spec" "$normalized_spec"; then
      require_index_section=1
    fi
    if spec_allows_legacy_related_adrs_none "$normalized_spec"; then
      allow_index_legacy_list_none=1
    fi
    if ! validate_related_adr_entries_from_stream "index ${normalized_spec}" "$require_index_section" "$allow_index_legacy_list_none" <<<"$index_content"; then
      return 1
    fi
      index_candidate_paths=("${related_adr_stream_paths[@]-}")
      all_index_candidate_paths+=("${index_candidate_paths[@]-}")
    fi
  done

  while IFS= read -r candidate_path; do
    [[ -z "$candidate_path" ]] || canonical_candidate_paths+=("$candidate_path")
  done < <(printf '%s\n' "${all_candidate_paths[@]-}" | LC_ALL=C sort -u)
  if [[ "${canonical_candidate_paths[*]-}" != "${frozen_paths[*]-}" ]]; then
    related_adr_error="frozen ADR membership drifted across candidate Specs"
    return 1
  fi

  while IFS= read -r candidate_path; do
    [[ -z "$candidate_path" ]] || canonical_index_candidate_paths+=("$candidate_path")
  done < <(printf '%s\n' "${all_index_candidate_paths[@]-}" | LC_ALL=C sort -u)
  if [[ "${canonical_index_candidate_paths[*]-}" != "${frozen_paths[*]-}" ]]; then
    related_adr_error="frozen ADR membership drifted in index across candidate Specs"
    return 1
  fi
}

related_adr_paths_from_stream() {
  local line=""
  local in_section=0

  while IFS= read -r line; do
    if [[ "$line" =~ ^##[[:space:]]+ ]]; then
      [[ "$line" == "## Related ADRs" || "$line" =~ ^##\ Related\ ADRs[[:space:]]+$ ]] && {
        in_section=1
        continue
      }
      [[ $in_section -eq 1 ]] && break
    fi
    [[ $in_section -eq 1 ]] || continue
    if [[ "$line" =~ ^-\ \[[^]]+\]\(\.\./\.\./(adr/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md)\)$ ]]; then
      printf 'docs/%s\n' "${BASH_REMATCH[1]}"
    fi
  done
}

related_adr_paths_for_spec() {
  local spec="$1"

  [[ "$spec" == docs/specs/*/SPEC.md && -f "$spec" && ! -L "$spec" ]] || return 0
  related_adr_paths_from_stream < "$spec"
}

validate_related_adr_entries_from_stream() {
  local label="$1"
  local require_section="$2"
  local allow_legacy_list_none="${3:-0}"
  local line=""
  local in_section=0
  local heading_count=0
  local none_count=0
  local saw_link=0
  local path=""
  local previous_path=""

  related_adr_stream_paths=()
  while IFS= read -r line; do
    if [[ "$line" =~ ^##\ Related\ ADRs[[:space:]]*$ ]]; then
      heading_count=$((heading_count + 1))
      in_section=1
      continue
    fi
    if [[ "$line" =~ ^##[[:space:]]+ ]] && [[ $in_section -eq 1 ]]; then
      in_section=0
      continue
    fi
    [[ $in_section -eq 1 ]] || continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if [[ "$line" == "None" ]] || [[ "$allow_legacy_list_none" -eq 1 && "$line" == "- None" ]]; then
      none_count=$((none_count + 1))
      continue
    fi
    if [[ "$line" =~ ^-\ \[[^]]+\]\(\.\./\.\./(adr/[[:digit:]]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md)\)$ ]]; then
      path="docs/${BASH_REMATCH[1]}"
      if [[ -n "$previous_path" ]] && [[ "$path" < "$previous_path" || "$path" == "$previous_path" ]]; then
        related_adr_error="invalid Related ADRs in ${label}: ADR paths must be unique and sorted"
        return 1
      fi
      previous_path="$path"
      related_adr_stream_paths+=("$path")
      saw_link=1
      continue
    fi
    related_adr_error="invalid Related ADRs in ${label}: entries must be None or canonical ADR links"
    return 1
  done

  if [[ "$heading_count" == "0" ]]; then
    if [[ "$require_section" -eq 1 ]]; then
      related_adr_error="invalid Related ADRs in ${label}: slug-only Specs require the section"
      return 1
    fi
    return 0
  fi
  if [[ "$heading_count" != "1" ]]; then
    related_adr_error="invalid Related ADRs in ${label}: section must appear exactly once"
    return 1
  fi
  if [[ "$none_count" -gt 0 && "$saw_link" -eq 1 ]] || [[ "$none_count" -ne 1 && "$saw_link" -eq 0 ]]; then
    related_adr_error="invalid Related ADRs in ${label}: use exactly None or one or more ADR links"
    return 1
  fi
  return 0
}

add_related_adr_target() {
  local target="$1"
  local existing=""

  for existing in "${related_adr_targets[@]-}"; do
    [[ "$existing" == "$target" ]] && return 0
  done
  related_adr_targets+=("$target")
}

referencing_specs_for_adr() {
  local adr_path="$1"
  local adr_relative="${adr_path#docs/}"
  local candidate=""

  while IFS= read -r candidate; do
    [[ -f "$candidate" ]] || continue
    if grep -Fq "(../../${adr_relative})" "$candidate"; then
      printf '%s\n' "$candidate"
    fi
  done < <(find docs/specs -mindepth 2 -maxdepth 2 -type f -name SPEC.md -print 2>/dev/null)
}

path_is_grandfathered_legacy_spec_rename() {
  local new_spec_path="$1"
  local compare_ref="$2"
  local old_spec_path=""
  local old_root=""
  local old_implementation=""
  local old_history=""
  local idx=0

  [[ -n "$new_spec_path" ]] || return 1
  while [[ $idx -lt ${#RENAME_NEW_FILES[@]} ]]; do
    old_spec_path="${RENAME_OLD_FILES[$idx]}"
    if [[ "${RENAME_NEW_FILES[$idx]}" != "$new_spec_path" ]]; then
      idx=$((idx + 1))
      continue
    fi

    legacy_spec_rename_matches "$old_spec_path" "$new_spec_path" "direct-rename" || {
      idx=$((idx + 1))
      continue
    }

    if ! git rev-parse --verify "${compare_ref}:${old_spec_path}" >/dev/null 2>&1; then
      idx=$((idx + 1))
      continue
    fi

    old_root="$(dirname "$old_spec_path")"
    old_implementation="${old_root}/IMPLEMENTATION.md"
    old_history="${old_root}/HISTORY.md"
    if git rev-parse --verify "${compare_ref}:${old_implementation}" >/dev/null 2>&1 \
      || git rev-parse --verify "${compare_ref}:${old_history}" >/dev/null 2>&1; then
      idx=$((idx + 1))
      continue
    fi

    return 0
  done

  for old_spec_path in "${DELETED_FILES[@]-}"; do
    case "$old_spec_path" in
      docs/specs/*/SPEC.md)
        ;;
      *)
        continue
        ;;
    esac

    [[ "$old_spec_path" != "$new_spec_path" ]] || continue
    legacy_spec_rename_matches "$old_spec_path" "$new_spec_path" || continue
    if ! git rev-parse --verify "${compare_ref}:${old_spec_path}" >/dev/null 2>&1; then
      continue
    fi

    old_root="$(dirname "$old_spec_path")"
    old_implementation="${old_root}/IMPLEMENTATION.md"
    old_history="${old_root}/HISTORY.md"
    if git rev-parse --verify "${compare_ref}:${old_implementation}" >/dev/null 2>&1 \
      || git rev-parse --verify "${compare_ref}:${old_history}" >/dev/null 2>&1; then
      continue
    fi

    return 0
  done

  return 1
}

find_grandfathered_legacy_spec_move_destination() {
  local old_spec_path="$1"
  local compare_ref="$2"
  local candidate=""
  local old_root=""
  local old_implementation=""
  local old_history=""

  [[ -n "$old_spec_path" ]] || return 1
  case "$old_spec_path" in
    docs/specs/*/SPEC.md)
      ;;
    *)
      return 1
      ;;
  esac

  if ! git rev-parse --verify "${compare_ref}:${old_spec_path}" >/dev/null 2>&1; then
    return 1
  fi

  old_root="$(dirname "$old_spec_path")"
  old_implementation="${old_root}/IMPLEMENTATION.md"
  old_history="${old_root}/HISTORY.md"
  if git rev-parse --verify "${compare_ref}:${old_implementation}" >/dev/null 2>&1 \
    || git rev-parse --verify "${compare_ref}:${old_history}" >/dev/null 2>&1; then
    return 1
  fi

  for candidate in "${CHANGED_FILES[@]-}"; do
    case "$candidate" in
      docs/specs/*/SPEC.md)
        ;;
      *)
        continue
        ;;
    esac

    [[ "$candidate" != "$old_spec_path" ]] || continue
    legacy_spec_rename_matches "$old_spec_path" "$candidate" || continue
    path_deleted "$candidate" && continue
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

find_moved_spec_target_destination() {
  local old_spec_path="$1"
  local old_id=""
  local candidate=""
  local existing=""
  local duplicate=0
  local nullglob_was_set=0
  local -a candidate_inputs=()
  local -a candidates=()

  [[ -n "$old_spec_path" ]] || return 1
  case "$old_spec_path" in
    docs/specs/*/SPEC.md)
      ;;
    *)
      return 1
      ;;
  esac

  local idx=0
  while [[ $idx -lt ${#RENAME_OLD_FILES[@]} ]]; do
    if [[ "${RENAME_OLD_FILES[$idx]}" == "$old_spec_path" ]] \
      && [[ "${RENAME_NEW_FILES[$idx]}" == docs/specs/*/SPEC.md ]] \
      && [[ -e "${RENAME_NEW_FILES[$idx]}" || -L "${RENAME_NEW_FILES[$idx]}" ]] \
      && legacy_spec_rename_matches "$old_spec_path" "${RENAME_NEW_FILES[$idx]}" "direct-rename"; then
      printf '%s' "${RENAME_NEW_FILES[$idx]}"
      return 0
    fi
    idx=$((idx + 1))
  done

  legacy_identity_catalog_proven "$old_spec_path" || return 1
  old_id="$(extract_spec_id_from_path "$old_spec_path")"
  [[ -n "$old_id" ]] || return 1
  candidate_inputs=("${CHANGED_FILES[@]-}")
  if shopt -q nullglob; then
    nullglob_was_set=1
  fi
  shopt -s nullglob
  candidate_inputs+=(docs/specs/"${old_id}"-*/SPEC.md docs/specs/"${old_id}":*/SPEC.md)
  if [[ "$nullglob_was_set" -eq 0 ]]; then
    shopt -u nullglob
  fi

  for candidate in "${candidate_inputs[@]-}"; do
    case "$candidate" in
      docs/specs/*/SPEC.md)
        ;;
      *)
        continue
        ;;
    esac

    [[ "$candidate" != "$old_spec_path" ]] || continue
    legacy_spec_rename_matches "$old_spec_path" "$candidate" || continue
    path_deleted "$candidate" && continue
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    duplicate=0
    for existing in "${candidates[@]-}"; do
      [[ "$existing" == "$candidate" ]] && duplicate=1
    done
    [[ "$duplicate" -eq 1 ]] || candidates+=("$candidate")
  done

  if [[ ${#candidates[@]} -eq 1 ]]; then
    printf '%s' "${candidates[0]}"
    return 0
  fi
  if [[ ${#candidates[@]} -gt 1 ]]; then
    return 2
  fi

  return 1
}

spec_compare_ref_for_required_files() {
  if [[ -n "${BASE_REF:-}" ]]; then
    printf '%s' "$BASE_REF"
    return 0
  fi

  printf 'HEAD'
}

canonical_spec_path_for_legacy_plan() {
  local spec_path="$1"
  local topic_slug=""

  case "$spec_path" in
    docs/plan/*/PLAN.md|docs/specs/*/PLAN.md)
      ;;
    *)
      return 1
      ;;
  esac

  topic_slug="$(legacy_topic_slug_from_path "$spec_path")" || return 1
  printf 'docs/specs/%s/SPEC.md' "$topic_slug"
}

required_spec_files_for_spec_path() {
  local spec_path="$1"
  local root=""
  local implementation_path=""
  local history_path=""
  local spec_is_new_root=0
  local compare_ref=""
  local canonical_spec_path=""
  local canonical_root=""
  local base_has_companions=0

  case "$spec_path" in
    docs/plan/*/PLAN.md|docs/specs/*/PLAN.md)
      compare_ref="$(spec_compare_ref_for_required_files)"
      if git rev-parse --verify "${compare_ref}:${spec_path}" >/dev/null 2>&1; then
        printf '%s\n' "$spec_path"
        return 0
      fi

      canonical_spec_path="$(canonical_spec_path_for_legacy_plan "$spec_path" || true)"
      if [[ -z "$canonical_spec_path" ]]; then
        printf '%s\n' "$spec_path"
        return 0
      fi

      canonical_root="$(dirname "$canonical_spec_path")"
      printf '%s\n' "$canonical_spec_path" \
        "${canonical_root}/IMPLEMENTATION.md" \
        "${canonical_root}/HISTORY.md"
      return 0
      ;;
  esac

  root="$(dirname "$spec_path")"
  implementation_path="${root}/IMPLEMENTATION.md"
  history_path="${root}/HISTORY.md"
  compare_ref="$(spec_compare_ref_for_required_files)"

  printf '%s\n' "${root}/SPEC.md"
  if ! git rev-parse --verify "${compare_ref}:${spec_path}" >/dev/null 2>&1; then
    if ! path_is_grandfathered_legacy_spec_rename "$spec_path" "$compare_ref"; then
      spec_is_new_root=1
    fi
  fi
  if git rev-parse --verify "${compare_ref}:${implementation_path}" >/dev/null 2>&1 \
    || git rev-parse --verify "${compare_ref}:${history_path}" >/dev/null 2>&1; then
    base_has_companions=1
  fi
  if [[ -e "$implementation_path" || -L "$implementation_path" || -e "$history_path" || -L "$history_path" ]] \
    || [[ $spec_is_new_root -eq 1 ]] \
    || [[ $base_has_companions -eq 1 ]] \
    || path_deleted "$implementation_path" \
    || path_deleted "$history_path"; then
    printf '%s\n' "$implementation_path" "$history_path"
  fi
}

spec_target_from_changed_path() {
  local path="$1"
  local rel=""

  case "$path" in
    docs/plan/*)
      rel="${path#docs/plan/}"
      [[ "$rel" == */* ]] || return 1
      printf 'docs/plan/%s/PLAN.md' "${rel%%/*}"
      return 0
      ;;
    docs/specs/*/PLAN.md)
      printf '%s' "$path"
      return 0
      ;;
    docs/specs/*)
      rel="${path#docs/specs/}"
      [[ "$rel" == */* ]] || return 1
      printf 'docs/specs/%s/SPEC.md' "${rel%%/*}"
      return 0
      ;;
  esac

  return 1
}

spec_root_has_deleted_required_file() {
  local spec_root="$1"

  path_deleted "${spec_root}/SPEC.md" && return 0
  path_deleted "${spec_root}/IMPLEMENTATION.md" && return 0
  path_deleted "${spec_root}/HISTORY.md" && return 0

  return 1
}

normalize_to_repo_rel() {
  local path="$1"
  local p="$path"
  local repo_phys=""
  local p_phys=""
  local alt_phys=""
  local candidate_abs=""

  while [[ "$p" == ./* ]]; do
    p="${p#./}"
  done

  if [[ -n "$REPO_ROOT" ]]; then
    repo_phys="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P || printf '%s' "$REPO_ROOT")"
  fi

  if [[ "$p" == /* ]]; then
    if [[ -e "$p" || -L "$p" ]]; then
      p_phys="$(
        cd "$(dirname "$p")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$p")"
      )"
    else
      p_phys="$p"
    fi

    if [[ -n "$repo_phys" ]] && [[ "$p_phys" == "$repo_phys/"* ]]; then
      p="${p_phys#"$repo_phys"/}"
    elif [[ "$p_phys" == /private/* ]]; then
      alt_phys="/${p_phys#/private/}"
      if [[ -n "$repo_phys" ]] && [[ "$alt_phys" == "$repo_phys/"* ]]; then
        p="${alt_phys#"$repo_phys"/}"
      else
        p="$p_phys"
      fi
    else
      p="$p_phys"
    fi
  elif [[ -n "$INVOCATION_CWD" ]]; then
    candidate_abs="${INVOCATION_CWD}/${p}"
    if [[ -e "$candidate_abs" || -L "$candidate_abs" ]]; then
      p_phys="$(
        cd "$(dirname "$candidate_abs")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$candidate_abs")"
      )"
      if [[ -n "$repo_phys" ]] && [[ "$p_phys" == "$repo_phys/"* ]]; then
        p="${p_phys#"$repo_phys"/}"
      elif [[ "$p_phys" == /private/* ]]; then
        alt_phys="/${p_phys#/private/}"
        if [[ -n "$repo_phys" ]] && [[ "$alt_phys" == "$repo_phys/"* ]]; then
          p="${alt_phys#"$repo_phys"/}"
        else
          p="$p_phys"
        fi
      else
        p="$p_phys"
      fi
    fi
  elif [[ -n "$repo_phys" ]] && [[ "$p" == "$repo_phys/"* ]]; then
    p="${p#"$repo_phys"/}"
  elif [[ -n "$REPO_ROOT" ]] && [[ "$p" == "$REPO_ROOT/"* ]]; then
    p="${p#"$REPO_ROOT"/}"
  fi

  printf '%s' "$p"
}

extract_spec_id_from_path() {
  local path="$1"
  local dir=""
  local base=""

  case "$path" in
    docs/specs/*/*|docs/plan/*/*)
      dir="$(basename "$(dirname "$path")")"
      ;;
    *)
      printf ''
      return 0
      ;;
  esac

  if [[ "$dir" == *-* ]]; then
    base="${dir%%-*}"
  elif [[ "$dir" == *:* ]]; then
    base="${dir%%:*}"
  else
    base="$dir"
  fi

  printf '%s' "$base"
}

legacy_topic_slug_from_dir() {
  local dir="$1"
  local topic="$dir"

  if [[ "$topic" =~ ^[0-9]{4}[-:] ]]; then
    topic="${topic:5}"
  elif [[ "$topic" =~ ^[[:alnum:]]{5}[-:] ]]; then
    topic="${topic:6}"
  fi

  printf '%s' "$topic"
}

is_legacy_spec_dir_name() {
  local dir="$1"

  [[ "$dir" =~ ^[0-9]{4}($|[-:]) ]] \
    || [[ "$dir" =~ ^[[:alnum:]]{5}[-:] ]]
}

legacy_history_proves_id() {
  local source_path="$1"
  local dir=""
  local legacy_id=""
  local topic_slug=""
  local history_path=""

  dir="$(basename "$(dirname "$source_path")")"
  is_legacy_spec_dir_name "$dir" || return 1
  legacy_id="$(extract_spec_id_from_path "$source_path")"
  topic_slug="$(legacy_topic_slug_from_dir "$dir")"
  history_path="docs/specs/${topic_slug}/HISTORY.md"
  [[ -n "$legacy_id" && -f "$history_path" ]] || return 1

  grep -Eq "^[[:space:]]*-[[:space:]]*Legacy compatibility identity:[[:space:]]*\`#?${legacy_id}\`([[:space:]]|\.|$)" "$history_path"
}

spec_allows_legacy_related_adrs_none() {
  local spec="$1"

  legacy_identity_catalog_proven "$spec" || legacy_history_proves_id "$spec"
}

catalog_stream_confirms_legacy_id() {
  local legacy_id="$1"
  local source_path="$2"
  local relative_path="$3"

  awk -v expected_id="$legacy_id" -v full_path="$source_path" -v relative_path="$relative_path" '
    function clean(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      gsub(/`/, "", value)
      return value
    }

    /^[[:space:]]*\|/ {
      row = $0
      sub(/^[[:space:]]*\|/, "", row)
      sub(/\|[[:space:]]*$/, "", row)
      count = split(row, cells, "|")
      for (column = 1; column <= count; column++) {
        cells[column] = clean(cells[column])
      }

      if (tolower(cells[1]) == "id") {
        header_seen = 1
        id_column = 0
        path_count = 0
        for (column = 1; column <= count; column++) {
          header = tolower(cells[column])
          if (header == "id") {
            id_column = column
          }
          if (header == "spec" || header == "plan" || header == "path") {
            path_columns[++path_count] = column
          }
        }
        next
      }

      if (!header_seen || !id_column || !path_count || tolower(cells[id_column]) != tolower(expected_id)) {
        next
      }
      for (column = 1; column <= path_count; column++) {
        path_value = cells[path_columns[column]]
        if (path_value == full_path || path_value == relative_path) {
          found = 1
        }
      }
    }

    END { exit(found ? 0 : 1) }
  '
}

legacy_identity_catalog_proven() {
  local source_path="$1"
  local dir=""
  local legacy_id=""
  local catalog_path=""
  local relative_path=""
  local ref=""

  case "$source_path" in
    docs/plan/*)
      catalog_path="docs/plan/README.md"
      relative_path="${source_path#docs/plan/}"
      ;;
    docs/specs/*)
      catalog_path="docs/specs/README.md"
      relative_path="${source_path#docs/specs/}"
      ;;
    *)
      return 1
      ;;
  esac

  dir="$(basename "$(dirname "$source_path")")"
  is_legacy_spec_dir_name "$dir" || return 1
  legacy_id="$(extract_spec_id_from_path "$source_path")"
  [[ -n "$legacy_id" ]] || return 1

  if [[ -f "$catalog_path" ]] \
    && catalog_stream_confirms_legacy_id "$legacy_id" "$source_path" "$relative_path" < "$catalog_path"; then
    return 0
  fi

  for ref in "$BASE_REF" HEAD; do
    [[ -n "$ref" ]] || continue
    if git show "${ref}:${catalog_path}" 2>/dev/null \
      | catalog_stream_confirms_legacy_id "$legacy_id" "$source_path" "$relative_path"; then
      return 0
    fi
  done

  return 1
}

legacy_topic_slug_from_path() {
  local source_path="$1"
  local proof_source="${2:-catalog}"
  local dir=""

  case "$proof_source" in
    catalog|direct-rename)
      legacy_identity_catalog_proven "$source_path" || return 1
      ;;
    *)
      return 1
      ;;
  esac

  dir="$(basename "$(dirname "$source_path")")"
  is_legacy_spec_dir_name "$dir" || return 1
  legacy_topic_slug_from_dir "$dir"
}

legacy_spec_rename_matches() {
  local old_spec_path="$1"
  local new_spec_path="$2"
  local proof_source="${3:-catalog}"
  local old_dir=""
  local new_dir=""
  local old_id=""
  local new_id=""
  local old_topic=""

  case "$old_spec_path:$new_spec_path" in
    docs/specs/*/SPEC.md:docs/specs/*/SPEC.md)
      ;;
    *)
      return 1
      ;;
  esac

  old_dir="$(basename "$(dirname "$old_spec_path")")"
  new_dir="$(basename "$(dirname "$new_spec_path")")"
  is_legacy_spec_dir_name "$old_dir" || return 1

  old_id="$(extract_spec_id_from_path "$old_spec_path")"
  old_topic="$(legacy_topic_slug_from_path "$old_spec_path" "$proof_source")" || return 1
  if is_legacy_spec_dir_name "$new_dir"; then
    new_id="$(extract_spec_id_from_path "$new_spec_path")"
    [[ -n "$old_id" && "$old_id" == "$new_id" ]]
    return
  fi

  [[ "$new_dir" == "$old_topic" ]]
}

resolve_legacy_plan_canonical_path() {
  local path="$1"
  local dir_rel=""
  local topic_slug=""
  local legacy_id=""
  local candidate=""
  local existing=""
  local duplicate=0
  local mapping_proven=0
  local -a candidates=()

  case "$path" in
    docs/plan/*/PLAN.md)
      dir_rel="${path#docs/plan/}"
      dir_rel="${dir_rel%/PLAN.md}"
      ;;
    docs/specs/*/PLAN.md)
      dir_rel="${path#docs/specs/}"
      dir_rel="${dir_rel%/PLAN.md}"
      ;;
    *)
      return 1
      ;;
  esac

  if topic_slug="$(legacy_topic_slug_from_path "$path")"; then
    mapping_proven=1
    legacy_id="$(extract_spec_id_from_path "$path")"
  fi

  for candidate in "docs/specs/${dir_rel}/SPEC.md"; do
    [[ -f "$candidate" || -L "$candidate" ]] || continue
    duplicate=0
    for existing in "${candidates[@]-}"; do
      [[ "$existing" == "$candidate" ]] && duplicate=1
    done
    [[ $duplicate -eq 1 ]] || candidates+=("$candidate")
  done

  if [[ $mapping_proven -eq 1 ]]; then
    candidate="docs/specs/${topic_slug}/SPEC.md"
    if [[ -f "$candidate" || -L "$candidate" ]]; then
      duplicate=0
      for existing in "${candidates[@]-}"; do
        [[ "$existing" == "$candidate" ]] && duplicate=1
      done
      [[ $duplicate -eq 1 ]] || candidates+=("$candidate")
    fi

    for candidate in docs/specs/"${legacy_id}"-*/SPEC.md docs/specs/"${legacy_id}":*/SPEC.md; do
      [[ -f "$candidate" || -L "$candidate" ]] || continue
      duplicate=0
      for existing in "${candidates[@]-}"; do
        [[ "$existing" == "$candidate" ]] && duplicate=1
      done
      [[ $duplicate -eq 1 ]] || candidates+=("$candidate")
    done
  fi

  if [[ ${#candidates[@]} -eq 1 ]]; then
    printf '%s' "${candidates[0]}"
    return 0
  fi
  if [[ ${#candidates[@]} -gt 1 ]]; then
    return 2
  fi
  return 1
}

resolve_legacy_spec_canonical_path() {
  local path="$1"
  local dir_rel=""
  local dir_name=""
  local topic_slug=""
  local legacy_id=""
  local candidate=""
  local existing=""
  local duplicate=0
  local -a candidates=()

  case "$path" in
    docs/specs/*/SPEC.md)
      dir_rel="${path#docs/specs/}"
      dir_rel="${dir_rel%/SPEC.md}"
      ;;
    *)
      return 1
      ;;
  esac

  dir_name="$(basename "$dir_rel")"

  # Legacy directories remain readable for checkout compatibility, but the
  # The slug-only directory is the only writable source of truth once it
  # exists. The explicit identity proof is sufficient to route a stale,
  # read-only compatibility copy to that canonical path.
  if [[ -e "$path" || -L "$path" ]] \
    && is_legacy_spec_dir_name "$dir_name" \
    && (legacy_identity_catalog_proven "$path" || legacy_history_proves_id "$path"); then
    topic_slug="$(legacy_topic_slug_from_dir "$dir_name")"
    candidate="docs/specs/${topic_slug}/SPEC.md"
    if [[ -f "$candidate" || -L "$candidate" ]] && [[ "$candidate" != "$path" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  fi

  if [[ -e "$path" || -L "$path" ]]; then
    printf '%s' "$path"
    return 0
  fi

  if candidate="$(find_moved_spec_target_destination "$path")"; then
    printf '%s' "$candidate"
    return 0
  fi

  topic_slug="$(legacy_topic_slug_from_path "$path")" || return 1
  legacy_id="$(extract_spec_id_from_path "$path")"

  for candidate in "docs/specs/${topic_slug}/SPEC.md" docs/specs/"${legacy_id}"-*/SPEC.md docs/specs/"${legacy_id}":*/SPEC.md; do
    [[ -f "$candidate" || -L "$candidate" ]] || continue
    duplicate=0
    for existing in "${candidates[@]-}"; do
      [[ "$existing" == "$candidate" ]] && duplicate=1
    done
    [[ $duplicate -eq 1 ]] || candidates+=("$candidate")
  done

  if [[ ${#candidates[@]} -eq 1 ]]; then
    printf '%s' "${candidates[0]}"
    return 0
  fi
  if [[ ${#candidates[@]} -gt 1 ]]; then
    return 2
  fi
  return 1
}

resolve_associated_spec_path() {
  local path="$1"
  local dir_rel=""
  local candidate=""
  local spec_id=""
  local existing=""

  case "$path" in
    docs/plan/*/PLAN.md|docs/specs/*/PLAN.md)
      if candidate="$(resolve_legacy_plan_canonical_path "$path")"; then
        printf '%s' "$candidate"
        return 0
      else
        resolution_status=$?
        if [[ "$resolution_status" -eq 2 ]]; then
          return 2
        fi
      fi
      if [[ -e "$path" || -L "$path" ]]; then
        printf '%s' "$path"
        return 0
      fi
      ;;
    docs/specs/*/SPEC.md)
      if candidate="$(resolve_legacy_spec_canonical_path "$path")"; then
        printf '%s' "$candidate"
        return 0
      else
        resolution_status=$?
        if [[ "$resolution_status" -eq 2 ]]; then
          return 2
        fi
      fi
      ;;
  esac

  if legacy_identity_catalog_proven "$path"; then
    spec_id="$(extract_spec_id_from_path "$path")"
  fi
  if [[ -n "$spec_id" ]]; then
    shopt -s nullglob
    for existing in docs/specs/"${spec_id}"-*/SPEC.md docs/specs/"${spec_id}":*/SPEC.md; do
      printf '%s' "$existing"
      shopt -u nullglob
      return 0
    done
    shopt -u nullglob
  fi

  printf '%s' "$path"
}

add_changed_file() {
  local path="$1"
  local existing
  [[ -z "$path" ]] && return 0

  for existing in "${CHANGED_FILES[@]-}"; do
    if [[ "$existing" == "$path" ]]; then
      return 0
    fi
  done

  CHANGED_FILES+=("$path")
}

add_worktree_changed_file() {
  local path="$1"
  local existing
  [[ -z "$path" ]] && return 0

  for existing in "${WORKTREE_CHANGED_FILES[@]-}"; do
    if [[ "$existing" == "$path" ]]; then
      return 0
    fi
  done

  WORKTREE_CHANGED_FILES+=("$path")
}

add_deleted_file() {
  local path="$1"
  local existing
  [[ -z "$path" ]] && return 0

  for existing in "${DELETED_FILES[@]-}"; do
    if [[ "$existing" == "$path" ]]; then
      return 0
    fi
  done

  DELETED_FILES+=("$path")
}

add_rename_mapping() {
  local old_path="$1"
  local new_path="$2"
  local idx=0

  [[ -n "$old_path" ]] || return 0
  [[ -n "$new_path" ]] || return 0

  while [[ $idx -lt ${#RENAME_OLD_FILES[@]} ]]; do
    if [[ "${RENAME_OLD_FILES[$idx]}" == "$old_path" && "${RENAME_NEW_FILES[$idx]}" == "$new_path" ]]; then
      return 0
    fi
    idx=$((idx + 1))
  done

  RENAME_OLD_FILES+=("$old_path")
  RENAME_NEW_FILES+=("$new_path")
}

parse_name_status_line() {
  local line="$1"
  local rest=""
  PARSE_STATUS=""
  PARSE_PATH1=""
  PARSE_PATH2=""

  if [[ -z "$line" ]] || [[ "$line" != *$'\t'* ]]; then
    return 1
  fi

  PARSE_STATUS="${line%%$'\t'*}"
  rest="${line#*$'\t'}"

  if [[ "$PARSE_STATUS" == R* ]] || [[ "$PARSE_STATUS" == C* ]]; then
    if [[ "$rest" != *$'\t'* ]]; then
      return 1
    fi
    PARSE_PATH1="${rest%%$'\t'*}"
    PARSE_PATH2="${rest#*$'\t'}"
    return 0
  fi

  PARSE_PATH1="$rest"
  return 0
}

add_changed_from_status_line() {
  local line="$1"

  parse_name_status_line "$line" || return 0

  if [[ "$PARSE_STATUS" == R* ]] || [[ "$PARSE_STATUS" == C* ]]; then
    add_changed_file "$PARSE_PATH1"
    add_changed_file "$PARSE_PATH2"
    if [[ "$PARSE_STATUS" == R* ]]; then
      add_deleted_file "$PARSE_PATH1"
      add_rename_mapping "$PARSE_PATH1" "$PARSE_PATH2"
    fi
    return 0
  fi

  add_changed_file "$PARSE_PATH1"
  if [[ "$PARSE_STATUS" == D* ]]; then
    add_deleted_file "$PARSE_PATH1"
  fi
}

add_worktree_from_status_line() {
  local line="$1"

  parse_name_status_line "$line" || return 0

  if [[ "$PARSE_STATUS" == R* ]] || [[ "$PARSE_STATUS" == C* ]]; then
    add_worktree_changed_file "$PARSE_PATH1"
    add_worktree_changed_file "$PARSE_PATH2"
    add_changed_file "$PARSE_PATH1"
    add_changed_file "$PARSE_PATH2"
    if [[ "$PARSE_STATUS" == R* ]]; then
      add_deleted_file "$PARSE_PATH1"
      add_rename_mapping "$PARSE_PATH1" "$PARSE_PATH2"
    fi
    return 0
  fi

  add_worktree_changed_file "$PARSE_PATH1"
  add_changed_file "$PARSE_PATH1"
  if [[ "$PARSE_STATUS" == D* ]]; then
    add_deleted_file "$PARSE_PATH1"
  fi
}

path_deleted() {
  local path="$1"
  local deleted
  for deleted in "${DELETED_FILES[@]-}"; do
    if [[ "$deleted" == "$path" ]]; then
      return 0
    fi
  done
  return 1
}

is_long_lived_branch() {
  local b="$1"
  [[ "$b" == "main" || "$b" == "master" || "$b" == "trunk" || "$b" == "develop" || "$b" == release/* || "$b" == hotfix/* || "$b" == support/* ]]
}

resolve_remote_head_ref() {
  local remote="$1"
  local remote_head=""
  local candidate=""
  [[ -z "$remote" ]] && return 1

  remote_head="$(git symbolic-ref --quiet --short "refs/remotes/${remote}/HEAD" 2>/dev/null || true)"
  if [[ -n "$remote_head" ]]; then
    printf '%s' "$remote_head"
    return 0
  fi

  for candidate in main master trunk develop; do
    if git rev-parse --verify "refs/remotes/${remote}/${candidate}" >/dev/null 2>&1; then
      printf '%s/%s' "$remote" "$candidate"
      return 0
    fi
  done

  return 1
}

is_untracked_impl_candidate() {
  local path="$1"
  local base
  base="$(basename "$path")"

  if [[ "$path" == docs/* ]] || [[ "$path" == README* ]] || [[ "$path" == .github/* ]]; then
    return 1
  fi

  if [[ "$base" == ".DS_Store" || "$base" == *.log || "$base" == *.tmp || "$base" == *.swp || "$base" == *.bak ]]; then
    return 1
  fi

  if [[ "$path" == src/* || "$path" == app/* || "$path" == web/src/* || "$path" == server/* || "$path" == backend/* || "$path" == frontend/* || "$path" == cmd/* || "$path" == pkg/* || "$path" == internal/* || "$path" == services/* || "$path" == modules/* || "$path" == crates/* || "$path" == libs/* ]]; then
    return 0
  fi

  if [[ "$base" == Dockerfile || "$base" == Containerfile || "$base" == Makefile || "$base" == GNUmakefile || "$base" == Procfile || "$base" == Gemfile || "$base" == Rakefile || "$base" == Vagrantfile || "$base" == Jenkinsfile ]]; then
    return 0
  fi

  if [[ "$path" == *.c || "$path" == *.cc || "$path" == *.cpp || "$path" == *.h || "$path" == *.hpp || "$path" == *.rs || "$path" == *.go || "$path" == *.py || "$path" == *.ts || "$path" == *.tsx || "$path" == *.js || "$path" == *.jsx || "$path" == *.mjs || "$path" == *.cjs || "$path" == *.java || "$path" == *.kt || "$path" == *.swift || "$path" == *.rb || "$path" == *.php || "$path" == *.cs || "$path" == *.sh || "$path" == *.bash || "$path" == *.zsh || "$path" == *.toml || "$path" == *.json || "$path" == *.yaml || "$path" == *.yml ]]; then
    return 0
  fi

  if [[ "$base" != *.* ]]; then
    return 0
  fi

  return 1
}

record_commit_file_change() {
  local changed="$1"
  local ns_index=0
  local ns_root=""

  [[ -z "$changed" ]] && return 0

  for ns_root in "${normalized_spec_roots[@]-}"; do
    if path_counts_as_spec_sync "$changed" "$ns_root" "${normalized_specs[$ns_index]}"; then
      commit_spec_touched_flags[$ns_index]=1
    fi
    ns_index=$((ns_index + 1))
  done

  if [[ "$changed" == docs/* ]] || [[ "$changed" == README* ]] || [[ "$changed" == .github/* ]]; then
    return 0
  fi

  commit_has_impl=1
}

has_merge_sync_coverage() {
  local impl_commit="$1"
  local spec_commit="$2"
  local merge_commit=""

  # A spec commit older than implementation cannot be used as merge-based coverage.
  if git merge-base --is-ancestor "$spec_commit" "$impl_commit" >/dev/null 2>&1; then
    return 1
  fi

  for merge_commit in "${MERGE_COMMITS[@]-}"; do
    if ! git merge-base --is-ancestor "$impl_commit" "$merge_commit" >/dev/null 2>&1; then
      continue
    fi
    if git merge-base --is-ancestor "$spec_commit" "$merge_commit" >/dev/null 2>&1; then
      return 0
    fi
  done

  return 1
}

related_adr_error=""

spec_requires_related_adrs() {
  local spec="$1"
  local required=""

  for required in "${RELATED_ADR_SECTION_REQUIRED_SPECS[@]-}"; do
    [[ "$required" == "$spec" ]] && return 0
  done
  return 1
}

source_path_requires_related_adrs() {
  local source_path="$1"
  local target="$2"
  local compare_ref=""
  local old_spec_path=""
  local changed_path=""
  local target_was_touched=0
  local idx=0

  [[ "$target" == docs/specs/*/SPEC.md ]] || return 1
  [[ "$source_path" == "$target" ]] || return 1
  for changed_path in "${CHANGED_FILES[@]-}"; do
    if [[ "$changed_path" == "$target" ]]; then
      target_was_touched=1
      break
    fi
  done
  [[ $target_was_touched -eq 1 ]] || return 1
  if legacy_identity_catalog_proven "$target" || legacy_history_proves_id "$target"; then
    return 1
  fi
  while [[ $idx -lt ${#RENAME_NEW_FILES[@]} ]]; do
    old_spec_path="${RENAME_OLD_FILES[$idx]}"
    if [[ "${RENAME_NEW_FILES[$idx]}" == "$target" ]] \
      && legacy_spec_rename_matches "$old_spec_path" "$target" "direct-rename"; then
      return 1
    fi
    idx=$((idx + 1))
  done
  for old_spec_path in "${DELETED_FILES[@]-}"; do
    if legacy_spec_rename_matches "$old_spec_path" "$target"; then
      return 1
    fi
  done
  compare_ref="$(spec_compare_ref_for_required_files)"
  path_is_grandfathered_legacy_spec_rename "$target" "$compare_ref" && return 1
  return 0
}

mark_related_adrs_section_required() {
  local spec="$1"
  local required=""

  for required in "${RELATED_ADR_SECTION_REQUIRED_SPECS[@]-}"; do
    [[ "$required" == "$spec" ]] && return 0
  done
  RELATED_ADR_SECTION_REQUIRED_SPECS+=("$spec")
}

validate_related_adrs_for_spec() {
  local spec="$1"
  local require_section=0
  local allow_legacy_list_none=0
  local index_entry=""
  local index_content=""

  related_adr_error=""
  [[ "$spec" == docs/specs/*/SPEC.md ]] || return 0

  spec_requires_related_adrs "$spec" && require_section=1
  spec_allows_legacy_related_adrs_none "$spec" && allow_legacy_list_none=1

  if [[ -e "$spec" || -L "$spec" ]]; then
    if [[ ! -f "$spec" || -L "$spec" ]]; then
      related_adr_error="invalid Related ADRs in ${spec}: candidate Spec must be a regular file"
      return 1
    fi
    if ! validate_related_adr_entries_from_stream "candidate ${spec}" "$require_section" "$allow_legacy_list_none" < "$spec"; then
      return 1
    fi
    if ! validate_related_adr_targets_for_source "candidate ${spec}" "worktree"; then
      return 1
    fi
  fi

  index_entry="$(git ls-files -s -- "$spec")"
  if [[ -n "$index_entry" ]]; then
    if [[ ! "$index_entry" =~ ^(100644|100755)[[:space:]]+[0-9a-f]{40}[[:space:]]+0[[:space:]] ]]; then
      related_adr_error="invalid Related ADRs in index ${spec}: Spec must be a regular file"
      return 1
    fi
    if ! index_content="$(git show ":${spec}" 2>/dev/null)"; then
      related_adr_error="invalid Related ADRs in index ${spec}: cannot read staged Spec"
      return 1
    fi
    if ! validate_related_adr_entries_from_stream "index ${spec}" "$require_section" "$allow_legacy_list_none" <<<"$index_content"; then
      return 1
    fi
    if ! validate_related_adr_targets_for_source "index ${spec}" "index"; then
      return 1
    fi
  elif [[ -e "$spec" || -L "$spec" ]] && git cat-file -e "HEAD:${spec}" 2>/dev/null; then
    related_adr_error="invalid Related ADRs in index ${spec}: staged candidate removed Spec"
    return 1
  fi
  return 0
}

validate_related_adr_targets_for_source() {
  local label="$1"
  local source="$2"
  local path=""
  local adr_status=""
  local index_entry=""
  local index_content=""

  [[ -n "${related_adr_stream_paths[*]-}" ]] || return 0
  for path in "${related_adr_stream_paths[@]}"; do
    case "$source" in
      worktree)
        if [[ ! -f "$path" || -L "$path" ]]; then
          related_adr_error="invalid Related ADRs in ${label}: missing ADR target ${path} (not a regular file)"
          return 1
        fi
        adr_status="$(awk '
          NR == 1 && $0 == "---" { in_front_matter=1; next }
          in_front_matter && $0 == "---" { exit }
          in_front_matter && /^status:[[:space:]]*/ {
            sub(/^status:[[:space:]]*/, "")
            sub(/[[:space:]]+$/, "")
            print
            exit
          }
        ' "$path")"
        ;;
      index)
        index_entry="$(git ls-files -s -- "$path")"
        if [[ ! "$index_entry" =~ ^(100644|100755)[[:space:]]+[0-9a-f]{40}[[:space:]]+0[[:space:]] ]]; then
          related_adr_error="invalid Related ADRs in ${label}: missing ADR target ${path} (not a regular index file)"
          return 1
        fi
        if ! index_content="$(git show ":${path}" 2>/dev/null)"; then
          related_adr_error="invalid Related ADRs in ${label}: cannot read staged ADR target ${path}"
          return 1
        fi
        adr_status="$(awk '
          NR == 1 && $0 == "---" { in_front_matter=1; next }
          in_front_matter && $0 == "---" { exit }
          in_front_matter && /^status:[[:space:]]*/ {
            sub(/^status:[[:space:]]*/, "")
            sub(/[[:space:]]+$/, "")
            print
            exit
          }
        ' <<<"$index_content")"
        ;;
      *)
        related_adr_error="invalid Related ADRs validation source"
        return 1
        ;;
    esac
    case "$adr_status" in
      ""|accepted)
        ;;
      superseded|deprecated)
        related_adr_error="invalid Related ADRs in ${label}: ADR ${path} is ${adr_status}"
        return 1
        ;;
      *)
        related_adr_error="invalid Related ADRs in ${label}: ADR ${path} has non-accepted status ${adr_status}"
        return 1
        ;;
    esac
  done
  return 0
}

exit_related_adr_blocked() {
  local evidence="$1"
  echo "Spec同步状态=阻断"
  echo "Spec漂移=存在"
  echo "Spec同步证据=${evidence}"
  echo "结束原因=${related_adr_error}"
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: spec_drift_check.sh [--base-ref <ref>] [--spec-path <path>]... [--spec-free]

Outputs:
  Spec同步状态=通过|阻断|未检查
  Spec漂移=存在|不存在|未检查
  Spec同步证据=<spec_paths@sha_csv|未检查>
  结束原因=<one-line>

Exit codes:
  0 => pass
  2 => blocked (drift found)
  3 => unchecked
USAGE
}

exit_unchecked() {
  local reason="$1"
  echo "Spec同步状态=未检查"
  echo "Spec漂移=未检查"
  echo "Spec同步证据=未检查"
  echo "结束原因=${reason}"
  exit 3
}

validate_canonical_spec_contracts() {
  local target="$1"
  local checker="${REPO_ROOT}/bin/spec_contract_check.ts"
  local output=""
  strict_spec_error=""

  [[ "$target" =~ ^docs/specs/[a-z0-9]+(-[a-z0-9]+)*/SPEC\.md$ ]] || return 0
  [[ -f "$target" && ! -L "$target" ]] || return 0
  if [[ ! -f "$checker" ]]; then
    # External/legacy repositories may not have adopted the global checker yet.
    # Keep their readable compatibility path; candidate dot-codex has the tool.
    return 0
  fi
  if ! output="$(bun "$checker" --path "$target" --repo-root "$REPO_ROOT" 2>&1)"; then
    strict_spec_error="${output//$'\n'/; }"
    return 1
  fi
  return 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-ref)
      if [[ $# -lt 2 ]] || [[ -z "${2:-}" ]]; then
        exit_unchecked "missing value for --base-ref"
      fi
      BASE_REF="${2:-}"
      shift 2
      ;;
    --spec-path)
      if [[ $# -lt 2 ]] || [[ -z "${2:-}" ]]; then
        exit_unchecked "missing value for --spec-path"
      fi
      SPEC_PATHS+=("${2:-}")
      shift 2
      ;;
    --spec-free)
      SPEC_FREE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      exit_unchecked "unknown argument: $1"
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Spec同步状态=未检查"
  echo "Spec漂移=未检查"
  echo "Spec同步证据=未检查"
  echo "结束原因=not in git repository"
  exit 3
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
INVOCATION_CWD="$(pwd -P)"
cd "$REPO_ROOT"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ "${SPEC_DISPOSITION:-}" == "not_needed" ]]; then
  SPEC_FREE=1
fi

if [[ -z "$BASE_REF" ]]; then
  UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  UPSTREAM_REMOTE="${UPSTREAM_REF%%/*}"
  REMOTE_HEAD_REF=""
  UPSTREAM_BRANCH_NAME="${UPSTREAM_REF#*/}"
  REMOTE_HEAD_BRANCH_NAME=""

  if [[ -n "$UPSTREAM_REMOTE" ]]; then
    REMOTE_HEAD_REF="$(resolve_remote_head_ref "$UPSTREAM_REMOTE" || true)"
  fi

  if [[ -z "$REMOTE_HEAD_REF" ]]; then
    while IFS= read -r remote; do
      [[ -z "$remote" ]] && continue
      REMOTE_HEAD_REF="$(resolve_remote_head_ref "$remote" || true)"
      if [[ -n "$REMOTE_HEAD_REF" ]]; then
        break
      fi
    done < <(git remote)
  fi

  REMOTE_HEAD_BRANCH_NAME="${REMOTE_HEAD_REF#*/}"

  if [[ -n "$UPSTREAM_REF" ]] && [[ "$UPSTREAM_REF" == "$REMOTE_HEAD_REF" ]]; then
    BASE_REF="$UPSTREAM_REF"
  elif [[ -n "$UPSTREAM_REF" ]] && [[ "$UPSTREAM_BRANCH_NAME" == "$CURRENT_BRANCH" ]] && is_long_lived_branch "$CURRENT_BRANCH"; then
    BASE_REF="$UPSTREAM_REF"
  elif [[ -n "$UPSTREAM_REF" ]] && is_long_lived_branch "$UPSTREAM_BRANCH_NAME"; then
    BASE_REF="$UPSTREAM_REF"
  elif [[ -n "$REMOTE_HEAD_REF" ]] && [[ "$CURRENT_BRANCH" == "$REMOTE_HEAD_BRANCH_NAME" ]]; then
    BASE_REF="$REMOTE_HEAD_REF"
  elif [[ -n "$REMOTE_HEAD_REF" ]]; then
    BASE_REF="$REMOTE_HEAD_REF"
  elif git rev-parse --verify refs/heads/main >/dev/null 2>&1; then
    BASE_REF="main"
  elif git rev-parse --verify refs/heads/master >/dev/null 2>&1; then
    BASE_REF="master"
  elif git rev-parse --verify refs/heads/trunk >/dev/null 2>&1; then
    BASE_REF="trunk"
  elif git rev-parse --verify refs/heads/develop >/dev/null 2>&1; then
    BASE_REF="develop"
  else
    BASE_REF=""
  fi
fi

if [[ -z "$BASE_REF" ]] || ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "Spec同步状态=未检查"
  echo "Spec漂移=未检查"
  echo "Spec同步证据=未检查"
  echo "结束原因=base ref not resolvable ($BASE_REF)"
  exit 3
fi

if ! git merge-base "$BASE_REF" HEAD >/dev/null 2>&1; then
  exit_unchecked "no merge base between $BASE_REF and HEAD"
fi

CHANGED_FILES=()
while IFS= read -r line; do
  add_changed_from_status_line "$line"
done < <(git -c core.quotepath=false diff --name-status -M "$BASE_REF...HEAD")

while IFS= read -r line; do
  add_worktree_from_status_line "$line"
done < <(git -c core.quotepath=false diff --name-status -M)

while IFS= read -r line; do
  add_worktree_from_status_line "$line"
done < <(git -c core.quotepath=false diff --name-status -M --cached)

while IFS= read -r line; do
  if is_untracked_impl_candidate "$line"; then
    add_changed_file "$line"
  fi
done < <(git ls-files --others --exclude-standard)

while IFS= read -r line; do
  if is_untracked_impl_candidate "$line"; then
    add_worktree_changed_file "$line"
    add_changed_file "$line"
    continue
  fi

  if [[ "$line" == docs/specs/* ]] || [[ "$line" == docs/plan/* ]]; then
    add_worktree_changed_file "$line"
    add_changed_file "$line"
  fi
done < <(git ls-files --others --exclude-standard)

if ! validate_frozen_adr_refs; then
  echo "Spec同步状态=阻断"
  echo "Spec漂移=存在"
  echo "Spec同步证据=ADR_REFS"
  echo "结束原因=${related_adr_error}"
  exit 2
fi

if [[ ${#CHANGED_FILES[@]} -eq 0 ]]; then
  echo "Spec同步状态=通过"
  echo "Spec漂移=不存在"
  echo "Spec同步证据=未检查"
  echo "结束原因=no changes in diff"
  exit 0
fi

has_impl_change=0
has_spec_change=0
has_worktree_impl_change=0
has_worktree_spec_change=0
spec_changed_paths=()
spec_evidence=()
normalized_specs=()
normalized_spec_roots=()

for path in "${CHANGED_FILES[@]-}"; do
  [[ -z "$path" ]] && continue

  if [[ "$path" == docs/specs/* ]] || [[ "$path" == docs/plan/* ]]; then
    has_spec_change=1
    spec_changed_paths+=("$path")
  fi

  if [[ "$path" == docs/* ]] || [[ "$path" == README* ]] || [[ "$path" == .github/* ]]; then
    continue
  fi
  has_impl_change=1
done

if [[ $SPEC_FREE -eq 1 ]] && [[ $has_spec_change -eq 1 ]]; then
  echo "Spec同步状态=阻断"
  echo "Spec漂移=存在"
  if [[ ${#spec_changed_paths[@]} -gt 0 ]]; then
    echo "Spec同步证据=$(evidence_csv "${spec_changed_paths[@]-}")"
  else
    echo "Spec同步证据=未检查"
  fi
  echo "结束原因=spec-free run touched spec files"
  exit 2
fi

if [[ $has_impl_change -eq 0 ]]; then
  docs_only_incomplete_spec=0
  docs_only_invalid_related_adrs=0
  checked_spec_targets=()
  related_adr_targets=()
  for changed_spec_path in "${spec_changed_paths[@]-}"; do
    spec_target="$(spec_target_from_changed_path "$changed_spec_path" || true)"
    [[ -n "$spec_target" ]] || continue

    already_checked=0
    for existing_target in "${checked_spec_targets[@]-}"; do
      if [[ "$existing_target" == "$spec_target" ]]; then
        already_checked=1
        break
      fi
    done
    if [[ $already_checked -eq 1 ]]; then
      continue
    fi
    checked_spec_targets+=("$spec_target")
    add_related_adr_target "$spec_target"
    if source_path_requires_related_adrs "$changed_spec_path" "$spec_target"; then
      mark_related_adrs_section_required "$spec_target"
    fi

    required_spec_paths=()
    while IFS= read -r required_spec_path; do
      [[ -z "$required_spec_path" ]] && continue
      required_spec_paths+=("$required_spec_path")
    done < <(required_spec_files_for_spec_path "$spec_target")

    if [[ ! -e "$spec_target" ]] \
      && [[ ! -L "$spec_target" ]] \
      && path_deleted "$spec_target" \
      && find_moved_spec_target_destination "$spec_target" >/dev/null 2>&1; then
      continue
    fi

    target_has_live_or_deleted_required_file=0
    for required_spec_path in "${required_spec_paths[@]-}"; do
      if [[ -e "$required_spec_path" || -L "$required_spec_path" ]] || path_deleted "$required_spec_path"; then
        target_has_live_or_deleted_required_file=1
        break
      fi
    done
    if [[ ! -e "$changed_spec_path" ]] \
      && [[ ! -L "$changed_spec_path" ]] \
      && [[ $target_has_live_or_deleted_required_file -eq 0 ]]; then
      continue
    fi

    for required_spec_path in "${required_spec_paths[@]-}"; do
      if [[ -e "$required_spec_path" || -L "$required_spec_path" ]]; then
        continue
      fi
      docs_only_incomplete_spec=1
      add_spec_evidence "$required_spec_path"
    done

  done

  for spec in "${SPEC_PATHS[@]-}"; do
    requested_spec="$(normalize_to_repo_rel "$spec")"
    if normalized_spec="$(resolve_associated_spec_path "$requested_spec")"; then
      :
    else
      resolution_status=$?
      if [[ "$resolution_status" -eq 2 ]]; then
        exit_unchecked "ambiguous legacy spec mapping; provide canonical --spec-path"
      fi
      exit_unchecked "unable to resolve associated spec path"
    fi

    already_checked=0
    for existing_target in "${related_adr_targets[@]-}"; do
      if [[ "$existing_target" == "$normalized_spec" ]]; then
        already_checked=1
        break
      fi
    done
    [[ $already_checked -eq 1 ]] || add_related_adr_target "$normalized_spec"
    if source_path_requires_related_adrs "$requested_spec" "$normalized_spec"; then
      mark_related_adrs_section_required "$normalized_spec"
    fi
  done

  for changed_adr_path in "${CHANGED_FILES[@]-}"; do
    [[ "$changed_adr_path" =~ ^docs/adr/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$ ]] || continue
    while IFS= read -r referencing_spec; do
      [[ -n "$referencing_spec" ]] || continue
      add_related_adr_target "$referencing_spec"
    done < <(referencing_specs_for_adr "$changed_adr_path")
  done

  for spec_target in "${related_adr_targets[@]-}"; do
    if ! validate_related_adrs_for_spec "$spec_target"; then
      docs_only_invalid_related_adrs=1
      add_spec_evidence "$spec_target"
    fi
  done

  for spec_target in "${checked_spec_targets[@]-}"; do
    if ! validate_canonical_spec_contracts "$spec_target"; then
      echo "Spec同步状态=阻断"
      echo "Spec漂移=存在"
      echo "Spec同步证据=$(evidence_csv "$spec_target")"
      echo "结束原因=${strict_spec_error}"
      exit 2
    fi
  done

  if [[ $docs_only_incomplete_spec -eq 1 ]]; then
    echo "Spec同步状态=阻断"
    echo "Spec漂移=存在"
    if [[ ${#spec_evidence[@]-} -gt 0 ]]; then
      echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
    else
      echo "Spec同步证据=未检查"
    fi
    echo "结束原因=changed spec directories are incomplete"
    exit 2
  fi

  if [[ $docs_only_invalid_related_adrs -eq 1 ]]; then
    if [[ ${#spec_evidence[@]-} -gt 0 ]]; then
      exit_related_adr_blocked "$(evidence_csv "${spec_evidence[@]-}")"
    fi
    exit_related_adr_blocked "未检查"
  fi

  echo "Spec同步状态=通过"
  echo "Spec漂移=不存在"
  if [[ ${#spec_changed_paths[@]} -gt 0 ]]; then
    echo "Spec同步证据=$(evidence_csv "${spec_changed_paths[@]-}")"
  else
    echo "Spec同步证据=未检查"
  fi
  echo "结束原因=docs/workflow-only changes"
  exit 0
fi

if [[ $SPEC_FREE -eq 1 ]] && [[ ${#SPEC_PATHS[@]} -eq 0 ]]; then
  echo "Spec同步状态=通过"
  echo "Spec漂移=不存在"
  echo "Spec同步证据=none(spec-free)"
  echo "结束原因=spec-free run (spec_disposition=not_needed)"
  exit 0
fi

if [[ ${#SPEC_PATHS[@]} -eq 0 ]]; then
  echo "Spec同步状态=未检查"
  echo "Spec漂移=未检查"
  if [[ ${#spec_changed_paths[@]} -gt 0 ]]; then
    echo "Spec同步证据=$(evidence_csv "${spec_changed_paths[@]-}")"
  else
    echo "Spec同步证据=未检查"
  fi
  echo "结束原因=impl changes found but no SPEC_PATHS provided"
  exit 3
fi

tracked_changed=0
associated_deleted=0
incomplete_associated_spec=0
for spec in "${SPEC_PATHS[@]-}"; do
  existing_spec=""
  duplicated=0
  requested_spec="$(normalize_to_repo_rel "$spec")"
  if normalized_spec="$(resolve_associated_spec_path "$requested_spec")"; then
    :
  else
    resolution_status=$?
    if [[ "$resolution_status" -eq 2 ]]; then
      exit_unchecked "ambiguous legacy spec mapping; provide canonical --spec-path"
    fi
    exit_unchecked "unable to resolve associated spec path"
  fi
  [[ -z "$normalized_spec" ]] && continue

  for existing_spec in "${normalized_specs[@]-}"; do
    if [[ "$existing_spec" == "$normalized_spec" ]]; then
      duplicated=1
      break
    fi
  done
  if [[ $duplicated -eq 1 ]]; then
    continue
  fi

  normalized_specs+=("$normalized_spec")
  if source_path_requires_related_adrs "$requested_spec" "$normalized_spec"; then
    mark_related_adrs_section_required "$normalized_spec"
  fi
  normalized_spec_root="$(dirname "$normalized_spec")"
  normalized_spec_roots+=("$normalized_spec_root")

  while IFS= read -r required_spec_path; do
    [[ -z "$required_spec_path" ]] && continue
    if [[ -e "$required_spec_path" || -L "$required_spec_path" ]]; then
      continue
    fi
    incomplete_associated_spec=1
    add_spec_evidence "$required_spec_path"
  done < <(required_spec_files_for_spec_path "$normalized_spec")

  for changed in "${CHANGED_FILES[@]-}"; do
    if path_counts_as_spec_sync "$changed" "$normalized_spec_root" "$normalized_spec"; then
      tracked_changed=1
      add_spec_evidence "$changed"
      if path_deleted "$normalized_spec"; then
        associated_deleted=1
      fi
    fi
  done
done

if [[ ${#normalized_specs[@]} -eq 0 ]]; then
  exit_unchecked "no valid SPEC_PATHS after normalization"
fi

if [[ $incomplete_associated_spec -eq 1 ]]; then
  echo "Spec同步状态=阻断"
  echo "Spec漂移=存在"
  if [[ ${#spec_evidence[@]} -gt 0 ]]; then
    echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
  else
    echo "Spec同步证据=未检查"
  fi
  echo "结束原因=associated spec files are missing"
  exit 2
fi

for normalized_spec in "${normalized_specs[@]-}"; do
  if ! validate_related_adrs_for_spec "$normalized_spec"; then
    add_spec_evidence "$normalized_spec"
    exit_related_adr_blocked "$(evidence_csv "${spec_evidence[@]-}")"
  fi
  if ! validate_canonical_spec_contracts "$normalized_spec"; then
    add_spec_evidence "$normalized_spec"
    echo "Spec同步状态=阻断"
    echo "Spec漂移=存在"
    echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
    echo "结束原因=${strict_spec_error}"
    exit 2
  fi
done

for changed_spec_path in "${spec_changed_paths[@]-}"; do
  changed_spec_target="$(spec_target_from_changed_path "$changed_spec_path" || true)"
  [[ -n "$changed_spec_target" ]] || continue
  already_validated=0
  for normalized_spec in "${normalized_specs[@]-}"; do
    if [[ "$normalized_spec" == "$changed_spec_target" ]]; then
      already_validated=1
      break
    fi
  done
  [[ $already_validated -eq 1 ]] && continue
  if source_path_requires_related_adrs "$changed_spec_path" "$changed_spec_target"; then
    mark_related_adrs_section_required "$changed_spec_target"
  fi
  if ! validate_related_adrs_for_spec "$changed_spec_target"; then
    add_spec_evidence "$changed_spec_target"
    exit_related_adr_blocked "$(evidence_csv "${spec_evidence[@]-}")"
  fi
done

related_adr_targets=()
for changed_adr_path in "${CHANGED_FILES[@]-}"; do
  [[ "$changed_adr_path" =~ ^docs/adr/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$ ]] || continue
  while IFS= read -r referencing_spec; do
    [[ -n "$referencing_spec" ]] || continue
    add_related_adr_target "$referencing_spec"
  done < <(referencing_specs_for_adr "$changed_adr_path")
done

for spec_target in "${related_adr_targets[@]-}"; do
  if ! validate_related_adrs_for_spec "$spec_target"; then
    add_spec_evidence "$spec_target"
    exit_related_adr_blocked "$(evidence_csv "${spec_evidence[@]-}")"
  fi
done

spec_worktree_changed=()
for _ in "${normalized_specs[@]-}"; do
  spec_worktree_changed+=(0)
done

for changed in "${WORKTREE_CHANGED_FILES[@]-}"; do
  [[ -z "$changed" ]] && continue

  if [[ "$changed" == docs/specs/* ]] || [[ "$changed" == docs/plan/* ]]; then
    ns_index=0
    for ns_root in "${normalized_spec_roots[@]-}"; do
      if path_counts_as_spec_sync "$changed" "$ns_root" "${normalized_specs[$ns_index]}"; then
        has_worktree_spec_change=1
        spec_worktree_changed[$ns_index]=1
        add_spec_evidence "$changed"
      fi
      ns_index=$((ns_index + 1))
    done
    continue
  fi

  if [[ "$changed" == docs/* ]] || [[ "$changed" == README* ]] || [[ "$changed" == .github/* ]]; then
    continue
  fi

  has_worktree_impl_change=1
done

if [[ $has_worktree_impl_change -eq 1 ]] && [[ $has_worktree_spec_change -eq 0 ]]; then
  echo "Spec同步状态=阻断"
  echo "Spec漂移=存在"
  echo "Spec同步证据=未检查"
  echo "结束原因=worktree implementation changes without associated spec sync"
  exit 2
fi

if [[ $tracked_changed -eq 1 ]]; then
  if [[ $associated_deleted -eq 1 ]]; then
    echo "Spec同步状态=阻断"
    echo "Spec漂移=存在"
    echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
    echo "结束原因=associated spec was deleted"
    exit 2
  fi

  impl_commits=()
  MERGE_COMMITS=()
  spec_commit_lists=()
  for _ in "${normalized_specs[@]-}"; do
    spec_commit_lists+=("")
  done
  while IFS= read -r commit; do
    [[ -z "$commit" ]] && continue
    commit_has_impl=0
    commit_spec_touched_flags=()
    for _ in "${normalized_specs[@]-}"; do
      commit_spec_touched_flags+=(0)
    done
    parent_info=()
    read -r -a parent_info <<<"$(git rev-list --parents -n 1 "$commit")"
    parent_count=$((${#parent_info[@]} - 1))
    if [[ "$parent_count" -gt 1 ]]; then
      MERGE_COMMITS+=("$commit")
    fi

    if [[ "$parent_count" -gt 1 ]]; then
      while IFS= read -r changed; do
        record_commit_file_change "$changed"
      done < <(git -c core.quotepath=false diff-tree --cc --no-commit-id --name-only -r "$commit")
    else
      while IFS= read -r change_line; do
        parse_name_status_line "$change_line" || continue
        if [[ "$PARSE_STATUS" == R* ]] || [[ "$PARSE_STATUS" == C* ]]; then
          record_commit_file_change "$PARSE_PATH1"
          record_commit_file_change "$PARSE_PATH2"
          continue
        fi
        record_commit_file_change "$PARSE_PATH1"
      done < <(git -c core.quotepath=false show --pretty=format: --name-status --first-parent "$commit")
    fi

    if [[ $commit_has_impl -eq 1 ]]; then
      impl_commits+=("$commit")
    fi

    ns_index=0
    for _ in "${normalized_specs[@]-}"; do
      if [[ "${commit_spec_touched_flags[$ns_index]}" -eq 1 ]]; then
        spec_commit_lists[$ns_index]="${spec_commit_lists[$ns_index]} $commit"
      fi
      ns_index=$((ns_index + 1))
    done
  done < <(git rev-list --topo-order "$BASE_REF..HEAD")

  if [[ ${#impl_commits[@]} -gt 0 ]]; then
    ns_index=0
    for ns in "${normalized_specs[@]-}"; do
      has_spec_worktree_change="${spec_worktree_changed[$ns_index]}"
      spec_commits="${spec_commit_lists[$ns_index]}"

      if [[ "$has_spec_worktree_change" -eq 1 ]]; then
        ns_index=$((ns_index + 1))
        continue
      fi

      if [[ -z "${spec_commits//[[:space:]]/}" ]]; then
        echo "Spec同步状态=阻断"
        echo "Spec漂移=存在"
        echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
        echo "结束原因=no associated spec commit found after implementation commits (${ns})"
        exit 2
      fi
      ns_index=$((ns_index + 1))
    done

    ns_index=0
    for ns in "${normalized_specs[@]-}"; do
      has_spec_worktree_change="${spec_worktree_changed[$ns_index]}"
      spec_commits="${spec_commit_lists[$ns_index]}"
      if [[ "$has_spec_worktree_change" -eq 1 ]]; then
        ns_index=$((ns_index + 1))
        continue
      fi

      for impl_commit in "${impl_commits[@]-}"; do
        related_to_spec=0
        covered_by_this_spec=0
        for spec_commit in $spec_commits; do
          if git merge-base --is-ancestor "$impl_commit" "$spec_commit" >/dev/null 2>&1; then
            related_to_spec=1
            covered_by_this_spec=1
            break
          fi
          if has_merge_sync_coverage "$impl_commit" "$spec_commit"; then
            related_to_spec=1
            covered_by_this_spec=1
            break
          fi
          if git merge-base --is-ancestor "$spec_commit" "$impl_commit" >/dev/null 2>&1; then
            related_to_spec=1
          fi
        done

        if [[ "$related_to_spec" -eq 0 ]] || [[ "$covered_by_this_spec" -eq 1 ]]; then
          continue
        fi

        covered_by_other_spec=0
        other_index=0
        for _ in "${normalized_specs[@]-}"; do
          if [[ "$other_index" -eq "$ns_index" ]]; then
            other_index=$((other_index + 1))
            continue
          fi

          other_spec_commits="${spec_commit_lists[$other_index]}"
          for other_spec_commit in $other_spec_commits; do
            if git merge-base --is-ancestor "$impl_commit" "$other_spec_commit" >/dev/null 2>&1; then
              covered_by_other_spec=1
              break
            fi
            if has_merge_sync_coverage "$impl_commit" "$other_spec_commit"; then
              covered_by_other_spec=1
              break
            fi
          done
          if [[ "$covered_by_other_spec" -eq 1 ]]; then
            break
          fi
          other_index=$((other_index + 1))
        done

        if [[ "$covered_by_other_spec" -eq 1 ]]; then
          continue
        fi

        echo "Spec同步状态=阻断"
        echo "Spec漂移=存在"
        echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
        echo "结束原因=implementation changes are newer than associated spec commit (${ns})"
        exit 2
      done

      ns_index=$((ns_index + 1))
    done

    for impl_commit in "${impl_commits[@]-}"; do
      impl_covered=0
      for spec_commits in "${spec_commit_lists[@]-}"; do
        for spec_commit in $spec_commits; do
          if git merge-base --is-ancestor "$impl_commit" "$spec_commit" >/dev/null 2>&1; then
            impl_covered=1
            break
          fi
          if has_merge_sync_coverage "$impl_commit" "$spec_commit"; then
            impl_covered=1
            break
          fi
        done
        if [[ "$impl_covered" -eq 1 ]]; then
          break
        fi
      done

      if [[ "$impl_covered" -eq 1 ]]; then
        continue
      fi

      all_specs_have_worktree_sync=1
      for has_sync in "${spec_worktree_changed[@]-}"; do
        if [[ "$has_sync" -eq 1 ]]; then
          continue
        fi
        all_specs_have_worktree_sync=0
        break
      done

      if [[ "$all_specs_have_worktree_sync" -eq 1 ]]; then
        continue
      fi

      echo "Spec同步状态=阻断"
      echo "Spec漂移=存在"
      echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
      echo "结束原因=implementation changes are newer than associated spec commit"
      exit 2
    done
  fi

  echo "Spec同步状态=通过"
  echo "Spec漂移=不存在"
  echo "Spec同步证据=$(evidence_csv "${spec_evidence[@]-}")"
  echo "结束原因=associated spec updated with implementation changes"
  exit 0
fi

if [[ $has_spec_change -eq 1 ]]; then
  echo "Spec同步状态=阻断"
  echo "Spec漂移=存在"
  echo "Spec同步证据=$(evidence_csv "${spec_changed_paths[@]-}")"
  echo "结束原因=only non-associated spec files changed while implementation changed"
  exit 2
fi

echo "Spec同步状态=阻断"
echo "Spec漂移=存在"
echo "Spec同步证据=未检查"
echo "结束原因=implementation changes without spec sync"
exit 2
