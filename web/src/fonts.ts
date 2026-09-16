/**
 * Which fonts this machine actually has, so that naming one is a choice from a
 * list rather than a guess at a spelling.
 *
 * The terminal's face used to be a text box, which is the honest implementation
 * of "the server cannot know what is installed" and a bad answer to "what can I
 * pick". A name typed one character wrong does not fail — it falls through to
 * the next face in the stack and looks exactly like the setting being ignored,
 * and there is nothing on screen to say which of the two happened.
 *
 * ## Why this is the client's question and not the server's
 *
 * Because the emulator renders **here**. The face has to exist on the machine
 * that is drawing the glyphs, and on a phone over Tailscale that is not the
 * machine the agents are on. A server-side `fc-list` would offer a desktop's
 * fonts to a phone that has none of them, which is a list of things that will
 * silently not work. It is also, on macOS, a five-second `system_profiler`
 * call.
 *
 * ## Two ways of asking, because neither is enough on its own
 *
 * `queryLocalFonts()` is the real answer: every family installed, including the
 * commercial one somebody bought last week that no list could have guessed. It
 * needs a permission and — the part that shapes the code below — a **transient
 * user activation**, so it cannot be called on mount. It is called on the
 * pointer going down on the dropdown instead, which is an activation, is
 * invisible when it works, and costs nothing when the browser has never heard of
 * it. Safari on a phone has not, which is the other half of why there is a
 * second method at all.
 *
 * The fallback is measurement. Draw a string in `"<candidate>", monospace` and
 * again in plain `monospace`: if the widths differ, the candidate resolved to
 * something, which means it is installed. It only finds fonts it already knows
 * to ask about, which is why the list below is long and unapologetically
 * opinionated — but it needs no permission, works in every browser, and is a few
 * milliseconds for a hundred names.
 *
 * Neither is authoritative and that is fine: this is a *dropdown*, not a
 * validator. The text box is still there behind `Custom…` for the face that
 * neither method found, and the server still accepts any string, because what is
 * *valid* and what is *offered* are different questions — a font installed after
 * this list was written is the same case as a font on a machine we are not
 * looking at.
 */

/**
 * The faces worth asking about by name.
 *
 * Coding faces people actually use, the ones macOS/Windows/Linux ship, and the
 * patched Nerd Font builds — those last because they are what somebody is most
 * likely to *want* named here, since they are the ones with the devicons in
 * them, and their names are the hardest to type from memory.
 *
 * Long rather than curated-short on purpose: every name that is not installed
 * costs one `measureText` and disappears, so the only price of a name being
 * here is the line it takes up.
 */
const CANDIDATES = [
  // macOS
  "SF Mono", "SFMono-Regular", "Menlo", "Monaco", "Andale Mono", "Courier New", "PT Mono",
  // Windows
  "Consolas", "Cascadia Code", "Cascadia Mono", "Lucida Console", "Courier",
  // Linux / free
  "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", "Noto Sans Mono", "Nimbus Mono PS",
  "FreeMono", "Terminus",
  // The usual coding faces
  "Fira Code", "Fira Mono", "JetBrains Mono", "Source Code Pro", "IBM Plex Mono",
  "Roboto Mono", "Inconsolata", "Hack", "Iosevka", "Iosevka Term", "Victor Mono",
  "Anonymous Pro", "Space Mono", "Ubuntu Sans Mono", "Geist Mono", "Commit Mono",
  "Recursive Mono Linear Static", "Comic Mono", "0xProto", "Maple Mono", "Departure Mono",
  "Monaspace Neon", "Monaspace Argon", "Monaspace Xenon", "Monaspace Radon", "Monaspace Krypton",
  "Aporetic Sans Mono", "Intel One Mono", "Martian Mono", "Red Hat Mono", "Spline Sans Mono",
  // Commercial, worth probing because somebody who bought one wants it named
  "Berkeley Mono", "MonoLisa", "Operator Mono", "PragmataPro", "Dank Mono", "Input Mono",
  "Gintronic", "Cartograph CF", "TX-02",
  // Patched builds. The stack in `terminals.ts` already appends several of these
  // for their glyphs; naming one here puts it in front, which is what somebody
  // means when they pick it.
  "FiraCode Nerd Font", "FiraCode Nerd Font Mono", "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono", "Hack Nerd Font", "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font", "SauceCodePro Nerd Font", "Iosevka Nerd Font",
  "MesloLGS NF", "MesloLGM NF", "Symbols Nerd Font Mono", "UbuntuMono Nerd Font",
  "BlexMono Nerd Font", "VictorMono Nerd Font", "GeistMono Nerd Font",
];

/**
 * What the last `queryLocalFonts()` returned, kept for the lifetime of the page.
 *
 * Module state rather than component state because Settings is opened and closed
 * repeatedly and the permission prompt is not something to make somebody answer
 * twice. It is also why this is not in React: the list is a fact about the
 * machine, it never changes while the window is open, and subscribing to it
 * would be a re-render for something that arrives once.
 */
let granted: string[] | null = null;

/** Measured once. The probe is cheap but it is not free, and nothing about it changes. */
let probed: string[] | null = null;

/**
 * Whether the browser can be asked properly at all. Read rather than assumed
 * because it decides whether the dropdown is worth a gesture hook.
 */
export function canEnumerate(): boolean {
  return typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function";
}

/**
 * Every family we can find, sorted, with the built-in probe list as the floor.
 *
 * Synchronous, because it is what the dropdown renders from and a dropdown that
 * appeared empty and filled in later would be a dropdown you have to open twice.
 * The asynchronous half is `enumerate()` below, and its result simply makes the
 * next render longer.
 */
export function knownFonts(): string[] {
  if (probed === null) probed = probe();
  return [...new Set([...(granted ?? []), ...probed])].sort((a, b) => a.localeCompare(b));
}

/**
 * Ask the browser for the real list. Call it from a click or a pointerdown.
 *
 * Returns whether anything new turned up, so a caller can re-render only when it
 * is worth it. Every failure is the same failure as far as this is concerned — no
 * such API, permission refused, no user activation — and none of them is worth
 * reporting: the dropdown already has the probe list in it and the text box is
 * still there. A permission dialog somebody dismissed is not an error state.
 */
export async function enumerate(): Promise<boolean> {
  if (granted || !canEnumerate()) return false;
  try {
    const query = (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts;
    const data = await query();
    const families = [...new Set(data.map((f) => f.family).filter(Boolean))];
    if (families.length === 0) return false;
    granted = families;
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of `CANDIDATES` resolve to something.
 *
 * Three generic families rather than one, because a candidate is only detectable
 * when it differs from the generic it is being compared against — and a face
 * that happens to *be* the browser's `monospace` would come out undetected
 * against that one alone. Measuring against all three and taking any difference
 * is the standard trick and the reason it is reliable.
 *
 * A canvas rather than a hidden span, because `measureText` needs no layout: a
 * span per candidate is a hundred forced reflows, which is the version of this
 * that is slow enough to notice.
 */
function probe(): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  // Wide, tall, round and narrow letters plus digits: enough that two faces of
  // the same nominal metrics still differ, which is where a shorter sample
  // gives false negatives.
  const sample = "mmmmmmmmmmlliWW0Oo@%$";
  const generics = ["monospace", "serif", "sans-serif"];
  const base = new Map<string, number>();
  for (const generic of generics) {
    ctx.font = `48px ${generic}`;
    base.set(generic, ctx.measureText(sample).width);
  }
  const found: string[] = [];
  for (const family of CANDIDATES) {
    for (const generic of generics) {
      ctx.font = `48px "${family}", ${generic}`;
      if (ctx.measureText(sample).width !== base.get(generic)) {
        found.push(family);
        break;
      }
    }
  }
  return found;
}
