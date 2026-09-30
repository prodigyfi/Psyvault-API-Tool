#!/usr/bin/env bash
#
# update-config.sh - rebuild config.json from config.example.json, keeping only
# the requested network.
#
# The contract addresses and tradingPairs of that network are taken from
# config.example.json, but the fields the user filled in (rpcNode / account /
# jsonWallet / passphrase / privateKey / is7702Account) are kept as they are.
# Every other address is overwritten with the example values.
#
# Only standard shell tools are used (no node, no jq). Both JSON files are read
# with awk by tracking the brace depth, so any indentation works, but each key
# must stay on its own line (the layout prettier produces). The result is always
# written with two spaces of indentation.
#
# Usage: ./update-config.sh "Base Mainnet" [options]

set -euo pipefail

cd "$(dirname "$0")"

EXAMPLE_FILE="config.example.json"
CONFIG_FILE="config.json"
DRY_RUN=0
BACKUP=1
NETWORK=""

# Fields filled in by the user; never overwritten with the example values
PRESERVED_KEYS="rpcNode account jsonWallet passphrase privateKey is7702Account"

usage() {
  cat <<'USAGE'
Usage: ./update-config.sh "<NETWORK>" [options]

Options:
  -e, --example <file>  Example config file (default: config.example.json)
  -c, --config <file>   Target config file (default: config.json)
  -l, --list            List the networks available in the example file and exit
  -n, --dry-run         Print the result without writing the file
      --no-backup       Do not create the <config>.bak backup
  -h, --help            Show this help

Example:
  ./update-config.sh "Base Mainnet"
  ./update-config.sh "base mainnet" --dry-run
USAGE
}

# Shared awk prelude: walk the input line by line and keep, for every line, the
# brace depth before it (`before`) and after it (`depth`), plus the key it
# declares (`k`, empty when the line declares none).
AWK_WALK='
  function scan(  opens, closes) {
    opens = gsub(/\{/, "{")
    closes = gsub(/\}/, "}")
    before = depth
    depth = before + opens - closes
    k = ""
    if ($0 ~ /^[ \t]*"/) {
      k = $0
      sub(/^[ \t]*"/, "", k)
      sub(/"[ \t]*:.*$/, "", k)
    }
  }
'

# Top-level keys of a config file, one per line, without basicSettings.
list_networks() {
  [ -f "$1" ] || return 0
  awk "$AWK_WALK"'
    { scan(); if (before == 1 && k != "" && k != "basicSettings") print k }
  ' "$1"
}

# Body of the object KEY: every line between its braces, both excluded. BASE is
# the depth the key itself sits at: 1 for a top-level key of a whole file, 0 for
# a key of a block body.
block_body() {
  BASE="$1" KEY="$2" awk "$AWK_WALK"'
    BEGIN { base = ENVIRON["BASE"] + 0; key = ENVIRON["KEY"] }
    {
      line = $0
      scan()
      if (inside) {
        if (depth <= base) exit
        print line
        next
      }
      if (before == base && k == key && line ~ /\{[ \t]*$/) inside = 1
    }
  '
}

# Keys of a block (read from stdin), one per line.
block_keys() {
  awk "$AWK_WALK"'{ scan(); if (before == 0 && k != "") print k }'
}

# Raw JSON value of KEY in a block (read from stdin), e.g. "0xabc" or false.
block_value() {
  KEY="$1" awk "$AWK_WALK"'
    BEGIN { key = ENVIRON["KEY"] }
    {
      value = $0
      scan()
      if (before == 0 && k == key) {
        sub(/^[ \t]*"[^"]*"[ \t]*:[ \t]*/, "", value)
        sub(/,[ \t]*$/, "", value)
        print value
        exit
      }
    }
  '
}

# Set KEY to VALUE in a block (read from stdin). The key is replaced in place
# when it exists, otherwise it is inserted as the first entry of the block.
block_set() {
  KEY="$1" VALUE="$2" awk "$AWK_WALK"'
    function indent_of(line) {
      match(line, /^[ \t]*/)
      return substr(line, 1, RLENGTH)
    }
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"] }
    {
      lines[NR] = $0
      scan()
      if (!found && before == 0 && k == key) found = NR
    }
    END {
      if (found) {
        comma = (lines[found] ~ /,[ \t]*$/) ? "," : ""
        lines[found] = indent_of(lines[found]) "\"" key "\": " value comma
      } else if (NR) {
        print indent_of(lines[1]) "\"" key "\": " value ","
      } else {
        print "    \"" key "\": " value
      }
      for (i = 1; i <= NR; i++) print lines[i]
    }
  '
}

# A value counts as filled in when it is present and not an empty JSON string.
is_filled() {
  case "$1" in
    "" | '""' | null) return 1 ;;
    *) return 0 ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -e|--example) EXAMPLE_FILE="${2:?--example requires an argument}"; shift 2 ;;
    -c|--config)  CONFIG_FILE="${2:?--config requires an argument}"; shift 2 ;;
    -l|--list)    NETWORK="__LIST__"; shift ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    --no-backup)  BACKUP=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$NETWORK" ]; then
        echo "Only one network can be given (already got \"$NETWORK\")" >&2
        exit 2
      fi
      NETWORK="$1"; shift ;;
  esac
done

if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "Example config file not found: $EXAMPLE_FILE" >&2
  exit 1
fi

NETWORKS="$(list_networks "$EXAMPLE_FILE")"
if [ -z "$NETWORKS" ]; then
  echo "No network found in $EXAMPLE_FILE (is every key on its own line?)" >&2
  exit 1
fi

# Refuse to run against a config whose layout cannot be read, rather than
# silently dropping the settings the user filled in.
if [ -s "$CONFIG_FILE" ] && [ -z "$(list_networks "$CONFIG_FILE")" ]; then
  echo "No network found in $CONFIG_FILE (is every key on its own line?)" >&2
  exit 1
fi

if [ -z "$NETWORK" ]; then
  usage >&2
  echo >&2
  NETWORK="__LIST__"
fi

if [ "$NETWORK" = "__LIST__" ]; then
  echo "Networks available in $EXAMPLE_FILE:"
  printf '%s\n' "$NETWORKS" | sed 's/^/  - /'
  exit 1
fi

# Match the network name exactly first, then case-insensitively.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
matched=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if [ "$name" = "$NETWORK" ]; then
    matched="$name"
    break
  fi
  if [ -z "$matched" ] && [ "$(lower "$name")" = "$(lower "$NETWORK")" ]; then
    matched="$name"
  fi
done <<EOF
$NETWORKS
EOF

if [ -z "$matched" ]; then
  echo "Network \"$NETWORK\" not found in $EXAMPLE_FILE. Available networks:" >&2
  printf '%s\n' "$NETWORKS" | sed 's/^/  - /' >&2
  exit 1
fi
NETWORK="$matched"

CHAIN_BLOCK="$(block_body 1 "$NETWORK" < "$EXAMPLE_FILE")"
if [ -z "$CHAIN_BLOCK" ]; then
  echo "Network \"$NETWORK\" has no settings in $EXAMPLE_FILE" >&2
  exit 1
fi

CURRENT_CHAIN_BLOCK=""
CURRENT_BASIC_BLOCK=""
if [ -f "$CONFIG_FILE" ]; then
  CURRENT_CHAIN_BLOCK="$(block_body 1 "$NETWORK" < "$CONFIG_FILE")"
  CURRENT_BASIC_BLOCK="$(block_body 1 basicSettings < "$CONFIG_FILE")"
fi

# Keep the fields the user filled in, overwrite every other address.
KEPT=""
for key in $PRESERVED_KEYS; do
  value="$(printf '%s\n' "$CURRENT_CHAIN_BLOCK" | block_value "$key")"
  if is_filled "$value"; then
    CHAIN_BLOCK="$(printf '%s\n' "$CHAIN_BLOCK" | block_set "$key" "$value")"
    KEPT="$KEPT${KEPT:+, }$key"
  fi
done

# basicSettings: start from the example, keep values the user already set
# (e.g. pythApiKey)
BASIC_BLOCK="$(block_body 1 basicSettings < "$EXAMPLE_FILE")"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  value="$(printf '%s\n' "$CURRENT_BASIC_BLOCK" | block_value "$key")"
  if is_filled "$value"; then
    BASIC_BLOCK="$(printf '%s\n' "$BASIC_BLOCK" | block_set "$key" "$value")"
  fi
done <<EOF
$(printf '%s\n' "$CURRENT_BASIC_BLOCK" | block_keys)
EOF

# Report the address fields that were overwritten
CHANGED=""
while IFS= read -r key; do
  [ -n "$key" ] || continue
  [ "$key" = "tradingPairs" ] && continue
  case " $PRESERVED_KEYS " in *" $key "*) continue ;; esac
  after="$(printf '%s\n' "$CHAIN_BLOCK" | block_value "$key")"
  before="$(printf '%s\n' "$CURRENT_CHAIN_BLOCK" | block_value "$key")"
  if [ "$before" != "$after" ]; then
    CHANGED="$CHANGED  $key: ${before:-(none)} -> $after
"
  fi
done <<EOF
$(printf '%s\n' "$CHAIN_BLOCK" | block_keys)
EOF

PAIRS="$(printf '%s\n' "$CHAIN_BLOCK" | block_body 0 tradingPairs | block_keys)"
PAIR_COUNT=0
[ -n "$PAIRS" ] && PAIR_COUNT="$(printf '%s\n' "$PAIRS" | wc -l | tr -d ' ')"
DROPPED="$(list_networks "$CONFIG_FILE" | grep -v "^$NETWORK\$" | tr '\n' ' ' || true)"

echo "Network: $NETWORK"
echo "Kept user settings: ${KEPT:-(none, using the example values)}"
if [ -n "$CHANGED" ]; then
  printf 'Updated addresses:\n%s' "$CHANGED"
else
  echo "Updated addresses: (no changes)"
fi
echo "tradingPairs ($PAIR_COUNT): $(printf '%s' "${PAIRS:-(none)}" | tr '\n' ' ')"
[ -n "$DROPPED" ] && echo "Removed other networks: $DROPPED"

render() {
  echo "{"
  if [ -n "$BASIC_BLOCK" ]; then
    echo '  "basicSettings": {'
    printf '%s\n' "$BASIC_BLOCK"
    echo '  },'
  else
    echo '  "basicSettings": {},'
  fi
  printf '  "%s": {\n' "$NETWORK"
  printf '%s\n' "$CHAIN_BLOCK"
  echo "  }"
  echo "}"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "--- dry-run, $CONFIG_FILE not written ---"
  render
else
  if [ "$BACKUP" -eq 1 ] && [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "$CONFIG_FILE.bak"
    echo
    echo "Backed up: $CONFIG_FILE.bak"
  fi
  render > "$CONFIG_FILE.tmp"
  mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
  echo "Wrote $CONFIG_FILE"
fi
