// electron-builder afterAllArtifactBuild hook: the dmg is not notarized by default (notarize:true only notarizes the .app).
// To keep a downloaded dmg clean even on its *first offline open*, the dmg itself must be submitted to notarytool + stapled.
// Uses the same credential env as notarize:true (API key or Apple ID). Skips if neither is present (the app is already notarized).
//
// Note: stapling the dmg after the build makes the *dmg* hash in latest-mac.yml stale. Auto-update uses the zip channel
// (the app is already stapled before the zip), so this is harmless — but driving updates via the dmg channel needs extra handling.
const { execFileSync } = require("node:child_process");

module.exports = async function afterAllArtifactBuild(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  if (dmgs.length === 0) return [];

  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  const hasApiKey = key && keyId && issuer;
  const hasAppleId = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  if (!hasApiKey && !hasAppleId) {
    console.warn("[notarize-dmg] no APPLE_* credential env → skipping dmg notarize/staple (the app is already notarized).");
    return [];
  }

  const creds = hasApiKey
    ? ["--key", key, "--key-id", keyId, "--issuer", issuer]
    : ["--apple-id", process.env.APPLE_ID, "--password", process.env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", process.env.APPLE_TEAM_ID];

  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] notarizing ${dmg} …`);
    execFileSync("xcrun", ["notarytool", "submit", dmg, ...creds, "--wait", "--timeout", "20m"], { stdio: "inherit" });
    console.log(`[notarize-dmg] stapling ${dmg} …`);
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
