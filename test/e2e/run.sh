#!/usr/bin/env bash
# Runs the end-to-end test: the built plugin and the test harness (test/e2e/harness) in a fresh
# profile of a real Zotero, under Xvfb. The harness writes <work-dir>/results.json and quits Zotero;
# Zotero's debug output goes to <work-dir>/zotero.log.
#
# Usage: test/e2e/run.sh <zotero-dir> <work-dir>
#   <zotero-dir>  unpacked Zotero for Linux (the folder with the `zotero` launcher)
#   <work-dir>    scratch folder; emptied first
# Env: ZB_E2E_KEYRING=1  start an unlocked gnome-keyring so Zotero.OSKeyStore works (and is expected to)
#      ZB_E2E_TIMEOUT    seconds before Zotero is killed (default 1200)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ZOTERO_DIR=$(cd "$1" && pwd)
WORK=$2
TIMEOUT=${ZB_E2E_TIMEOUT:-1200}

rm -rf "$WORK"
mkdir -p "$WORK/profile/extensions" "$WORK/data" "$WORK/fixtures"
WORK=$(cd "$WORK" && pwd)

VERSION=$(node -p "require('$ROOT/manifest.json').version")
PLUGIN_ID=$(node -p "require('$ROOT/manifest.json').applications.zotero.id")
HARNESS_ID=$(node -p "require('$ROOT/test/e2e/harness/manifest.json').applications.zotero.id")
XPI="$ROOT/dist/zotero-bridge-$VERSION.xpi"
test -f "$XPI" || { echo "missing $XPI: run npm run build first" >&2; exit 2; }

# Sideloading: an add-on file named <id>.xpi in <profile>/extensions is installed at startup
# (profile scope); autoDisableScopes=0 keeps it enabled without asking
cp "$XPI" "$WORK/profile/extensions/$PLUGIN_ID.xpi"
(cd "$ROOT/test/e2e/harness" && zip -qrX "$WORK/profile/extensions/$HARNESS_ID.xpi" manifest.json bootstrap.js)
node "$ROOT/test/e2e/make-fixtures.mjs" "$WORK/fixtures"

EXPECT_KEYSTORE=false
if [ "${ZB_E2E_KEYRING:-0}" = 1 ]; then EXPECT_KEYSTORE=true; fi

cat > "$WORK/profile/user.js" <<EOF
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.update.autoUpdateDefault", false);
user_pref("app.update.auto", false);
user_pref("app.update.enabled", false);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("extensions.logging.enabled", true);
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.dataDir", "$WORK/data");
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
user_pref("extensions.zb-e2e.workDir", "$WORK");
user_pref("extensions.zb-e2e.expectedVersion", "$VERSION");
user_pref("extensions.zb-e2e.expectKeyStore", $EXPECT_KEYSTORE);
EOF

echo "Zotero: $ZOTERO_DIR"
for ini in "$ZOTERO_DIR/application.ini" "$ZOTERO_DIR/app/application.ini"; do
	if [ -f "$ini" ]; then grep -E '^(Version|BuildID)=' "$ini" | sed 's/^/  /'; fi
done
echo "Plugin: $PLUGIN_ID $VERSION; harness: $HARNESS_ID; work dir: $WORK"

LAUNCH=(xvfb-run -a -s "-screen 0 1600x1200x24" "$ZOTERO_DIR/zotero" -profile "$WORK/profile" -no-remote -ZoteroDebugText)
if [ "$EXPECT_KEYSTORE" = true ]; then
	# A private D-Bus session with an unlocked keyring: libsecret (Mozilla's OSKeyStore on Linux) works
	timeout --kill-after=30 "$TIMEOUT" dbus-run-session -- bash -c \
		'printf e2e | gnome-keyring-daemon --unlock --components=secrets >/dev/null; exec "$@"' bash "${LAUNCH[@]}" \
		> "$WORK/zotero.log" 2>&1 &
else
	timeout --kill-after=30 "$TIMEOUT" "${LAUNCH[@]}" > "$WORK/zotero.log" 2>&1 &
fi
PID=$!
# Don't wait the whole timeout when the harness never starts (plugin not installed, Zotero stuck)
for _ in $(seq 1 ${ZB_E2E_START_TIMEOUT:-240}); do
	if grep -aq '\[zb-e2e\] harness started' "$WORK/zotero.log" 2>/dev/null || ! kill -0 "$PID" 2>/dev/null; then break; fi
	sleep 1
done
if ! grep -aq '\[zb-e2e\] harness started' "$WORK/zotero.log"; then
	echo "The harness did not start within ${ZB_E2E_START_TIMEOUT:-240} s; stopping Zotero"
	pkill -TERM -f "$WORK/profile" || true
	sleep 5
	pkill -KILL -f "$WORK/profile" || true
fi
STATUS=0
wait "$PID" || STATUS=$?
echo "Zotero exited with status $STATUS"
grep -a '\[zb-e2e\]' "$WORK/zotero.log" || true
node "$ROOT/test/e2e/report.mjs" "$WORK"
