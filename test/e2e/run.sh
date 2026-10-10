#!/usr/bin/env bash
# Runs the end-to-end test: the built plugin and the test harness (test/e2e/harness) in a fresh
# profile of a real Zotero, under Xvfb. The harness writes <work-dir>/results.json and quits Zotero;
# Zotero's debug output goes to <work-dir>/zotero.log.
#
# Zotero is started twice: first without the plugin (baseline: which console errors Zotero itself
# logs at startup, in baseline.json), then with it (the checks).
#
# Usage: test/e2e/run.sh <zotero-dir> <work-dir>
#   <zotero-dir>  unpacked Zotero for Linux (the folder with the `zotero` launcher)
#   <work-dir>    scratch folder; emptied first
# Env: ZB_E2E_KEYRING=1       start an unlocked gnome-keyring so Zotero.OSKeyStore works (and is expected to)
#      ZB_E2E_TIMEOUT         seconds before Zotero is killed (default 1200)
#      ZB_E2E_START_TIMEOUT   seconds to wait for the harness to start (default 240)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ZOTERO_DIR=$(cd "$1" && pwd)
WORK=$2
TIMEOUT=${ZB_E2E_TIMEOUT:-1200}
START_TIMEOUT=${ZB_E2E_START_TIMEOUT:-240}

rm -rf "$WORK"
mkdir -p "$WORK/fixtures"
WORK=$(cd "$WORK" && pwd)

VERSION=$(node -p "require('$ROOT/manifest.json').version")
PLUGIN_ID=$(node -p "require('$ROOT/manifest.json').applications.zotero.id")
HARNESS_ID=$(node -p "require('$ROOT/test/e2e/harness/manifest.json').applications.zotero.id")
XPI="$ROOT/dist/zotero-bridge-$VERSION.xpi"
test -f "$XPI" || { echo "missing $XPI: run npm run build first" >&2; exit 2; }
(cd "$ROOT/test/e2e/harness" && zip -qrX "$WORK/harness.xpi" manifest.json bootstrap.js)
node "$ROOT/test/e2e/make-fixtures.mjs" "$WORK/fixtures"

EXPECT_KEYSTORE=false
if [ "${ZB_E2E_KEYRING:-0}" = 1 ]; then EXPECT_KEYSTORE=true; fi

# make_profile <name> <harness mode> [plugin .xpi]
make_profile() {
	local profile="$WORK/$1"
	mkdir -p "$profile/extensions" "$WORK/$1-data"
	# Sideloading: an add-on file named <id>.xpi in <profile>/extensions is installed at startup
	# (profile scope); autoDisableScopes=0 keeps it enabled without asking
	cp "$WORK/harness.xpi" "$profile/extensions/$HARNESS_ID.xpi"
	if [ -n "${3:-}" ]; then cp "$3" "$profile/extensions/$PLUGIN_ID.xpi"; fi
	cat > "$profile/user.js" <<EOF
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
user_pref("extensions.zotero.dataDir", "$WORK/$1-data");
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
// The ZotMax setup wizard (content/setup.js) opens by itself on a fresh install (ADDON_INSTALL here); the
// tests open it themselves, so it must not pop up over them
user_pref("extensions.zotero-bridge.setup.done", true);
user_pref("extensions.zb-e2e.workDir", "$WORK");
user_pref("extensions.zb-e2e.mode", "$2");
user_pref("extensions.zb-e2e.expectedVersion", "$VERSION");
user_pref("extensions.zb-e2e.expectKeyStore", $EXPECT_KEYSTORE);
EOF
}

# launch <profile name> <log file>: runs Zotero until the harness quits it (or a timeout)
launch() {
	local profile="$WORK/$1" log="$2"
	local cmd=(xvfb-run -a -s "-screen 0 1600x1200x24" "$ZOTERO_DIR/zotero" -profile "$profile" -no-remote -ZoteroDebugText)
	if [ "$EXPECT_KEYSTORE" = true ]; then
		# A private D-Bus session with an unlocked keyring: libsecret (Mozilla's OSKeyStore on Linux) works
		timeout --kill-after=30 "$TIMEOUT" dbus-run-session -- bash -c \
			'printf e2e | gnome-keyring-daemon --unlock --components=secrets >/dev/null; exec "$@"' bash "${cmd[@]}" \
			> "$log" 2>&1 &
	else
		timeout --kill-after=30 "$TIMEOUT" "${cmd[@]}" > "$log" 2>&1 &
	fi
	local pid=$!
	# Don't wait the whole timeout when the harness never starts (add-on not installed, Zotero stuck)
	for _ in $(seq 1 "$START_TIMEOUT"); do
		if grep -aq '\[zb-e2e\] harness started' "$log" 2>/dev/null || ! kill -0 "$pid" 2>/dev/null; then break; fi
		sleep 1
	done
	if ! grep -aq '\[zb-e2e\] harness started' "$log"; then
		echo "The harness did not start within $START_TIMEOUT s; stopping Zotero"
		pkill -TERM -f "$profile" || true
		sleep 5
		pkill -KILL -f "$profile" || true
	fi
	local status=0
	wait "$pid" || status=$?
	echo "Zotero exited with status $status"
}

echo "Zotero: $ZOTERO_DIR"
for ini in "$ZOTERO_DIR/application.ini" "$ZOTERO_DIR/app/application.ini"; do
	if [ -f "$ini" ]; then grep -E '^(Version|BuildID)=' "$ini" | sed 's/^/  /'; fi
done
echo "Plugin: $PLUGIN_ID $VERSION; harness: $HARNESS_ID; work dir: $WORK"

echo "--- Baseline: Zotero without the plugin"
make_profile profile-baseline baseline
launch profile-baseline "$WORK/zotero-baseline.log"
grep -a '\[zb-e2e\]' "$WORK/zotero-baseline.log" || true

echo "--- Zotero with the plugin"
make_profile profile test "$XPI"
launch profile "$WORK/zotero.log"
grep -a '\[zb-e2e\]' "$WORK/zotero.log" || true
node "$ROOT/test/e2e/report.mjs" "$WORK"
