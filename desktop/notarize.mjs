/**
 * Hand the signed app to Apple, wait for the answer, and staple it on.
 *
 * Notarization is not a second signature — it is Apple scanning the thing and
 * issuing a ticket that says they have. Gatekeeper on somebody else's Mac wants
 * that ticket, and `stapler` is what attaches it to the bundle so the first
 * launch does not depend on their network. Without it, a downloaded kururu shows
 * the dialog with no *Open* button in it, and the only way past is System
 * Settings — which for an app that spawns terminals and asks for your Claude
 * login is a bad first impression to have to argue with.
 *
 * This runs as `afterSign`, which is the one moment it can: the app is complete
 * and signed, and the DMG and the zip have not been built from it yet. Doing it
 * later would put an unstapled app inside both — and the zip is what the updater
 * downloads, so an unstapled one there is a self-update that fails on the far
 * side with nothing to say why.
 *
 * `notarytool` will not take a bare `.app`, so it is zipped first with `ditto`
 * rather than `zip`: ditto is the one that preserves symlinks and extended
 * attributes inside a bundle, and a mangled framework is a rejection whose log
 * talks about code signing rather than about zip.
 *
 * Credentials come from one of three places and the order is deliberate. The
 * two environment shapes are what CI has, since a runner has no keychain worth
 * the name; the keychain profile is what a person has on their own machine
 * (`xcrun notarytool store-credentials`). Checking the environment first means
 * CI never accidentally finds a profile from a cached image.
 *
 * Both environment shapes are supported because `store-credentials` accepts
 * either — an App Store Connect API key, or an Apple ID with an app-specific
 * password — and which one somebody used is not recoverable afterwards: the
 * profile keeps the secret and tells nobody what kind it is. Supporting one
 * would mean guessing, and guessing wrong is a release that cannot be built
 * until somebody goes and makes a new credential.
 *
 * It is skipped entirely when the build was not signed. `CSC_IDENTITY_AUTO_DISCOVERY=false`
 * is how an unsigned build is asked for, and an unsigned app cannot be
 * notarized — so the skip is not a convenience, it is the only correct answer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The profile `xcrun notarytool store-credentials` was told to call itself. */
const PROFILE = process.env.KURURU_NOTARY_PROFILE || "kururu";

/**
 * Whichever of the three is available, in that order. The `.p8` is named by
 * path rather than by content because that is what `notarytool` takes, and it
 * is what electron-builder's own `APPLE_API_KEY` means too — so a repository
 * already set up for one is set up for the other.
 */
function pickCredentials() {
  if (process.env.APPLE_API_KEY) {
    return [
      "--key",
      process.env.APPLE_API_KEY,
      "--key-id",
      process.env.APPLE_API_KEY_ID ?? "",
      "--issuer",
      process.env.APPLE_API_ISSUER ?? "",
    ];
  }
  if (process.env.APPLE_ID) {
    return [
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD ?? "",
      "--team-id",
      process.env.APPLE_TEAM_ID ?? "",
    ];
  }
  return ["--keychain-profile", PROFILE];
}

export default async function notarize(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName !== "darwin") return;

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false" || process.env.KURURU_SKIP_NOTARIZE === "1") {
    console.log("  • notarize        skipped — this build is not signed");
    return;
  }

  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  if (!existsSync(app)) throw new Error(`nothing to notarize at ${app}`);

  const credentials = pickCredentials();

  const archive = join(tmpdir(), `kururu-notarize-${process.pid}.zip`);
  try {
    console.log(`  • notarize        zipping ${app}`);
    execFileSync("ditto", ["-c", "-k", "--keepParent", app, archive]);

    console.log(`  • notarize        submitting to Apple — this takes a few minutes`);
    execFileSync("xcrun", ["notarytool", "submit", archive, ...credentials, "--wait"], { stdio: "inherit" });

    console.log(`  • notarize        stapling the ticket on`);
    execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
  } finally {
    rmSync(archive, { force: true });
  }
}
