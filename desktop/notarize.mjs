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
 * Credentials come from one of two places and the order is deliberate. A
 * keychain profile is what a person has on their own machine (`xcrun notarytool
 * store-credentials`), and API-key environment variables are what CI has, since
 * a runner has no keychain worth the name. Checking the environment first means
 * CI never accidentally finds a profile from a cached image.
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

export default async function notarize(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName !== "darwin") return;

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false" || process.env.KURURU_SKIP_NOTARIZE === "1") {
    console.log("  • notarize        skipped — this build is not signed");
    return;
  }

  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  if (!existsSync(app)) throw new Error(`nothing to notarize at ${app}`);

  const credentials = process.env.APPLE_API_KEY
    ? [
        "--key",
        process.env.APPLE_API_KEY,
        "--key-id",
        process.env.APPLE_API_KEY_ID,
        "--issuer",
        process.env.APPLE_API_ISSUER,
      ]
    : ["--keychain-profile", PROFILE];

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
