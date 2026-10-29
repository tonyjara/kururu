/**
 * A card popped out as a window of its own: what a note window loads.
 *
 * The desktop app keeps a note over every application, not only over this
 * one (`desktop/notes.js`), and a window over another application is a
 * window of its own. This is what is in it, and it is deliberately the same
 * build with most of it not mounted, as the pill is: `main.tsx` renders this
 * instead of `App` for a `?note=` address, and what mounts is the session —
 * for the card, its board and its run — and the note. No panes, no
 * emulators, no notifications, so it has no vote in the size policy and
 * makes no sound the window is already making.
 *
 * **One drawing of a note.** Its bar, its body, its editor and its foot are
 * `NoteInside`, the very component the window's notes draw (`Notes.tsx`), so
 * a note window is the card looked up by id in the snapshot on every render,
 * and its editor is the board's composer through the board's verbs. What is
 * different is only what the window is: the desktop moves it by its title
 * bar (`-webkit-app-region`) and resizes it from its edges, folding it is the
 * window getting shorter, and "show it on its board" brings the main window
 * up to do it there — as "Reference in Kuru" does, since Kuru's box is the
 * window's and the reference is written there, from the card's id alone.
 *
 * **Which card is the main process's word, not the address's.** The page
 * asks the bridge which note it is (`self`), and the main process answers
 * for the window whose page asked, so a page cannot make itself another
 * card's note. It tells the main process back what it is showing: its card,
 * nothing because the card's profile is not the active one — the snapshot
 * carries only the active profile's cards — or that the card is gone; and
 * the card's title, for the menu bar's list.
 */
import { useEffect, useRef, useState } from "react";
import { skinFor } from "../../../shared/skin";
import { themeFor } from "../../../shared/theme";
import type { NoteReport, NoteSelf } from "../desktop";
import { desktopNotes, locateCard } from "../notes";
import { installReload } from "../reload";
import { useKururu } from "../session";
import { applySkin } from "../skin";
import { applyTheme } from "../theme";
import { NoteInside, readNote } from "./Notes";

export function NotePage() {
  const { snapshot } = useKururu();
  const [self, setSelf] = useState<NoteSelf | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("note-page");
    const notes = desktopNotes();
    // An agent's reload reaches a note too: a hot update leaves an old copy
    // of a module behind here as it does in the window.
    const stopReload = installReload("note");
    const stopSelf = notes?.onSelf(setSelf) ?? (() => {});
    const stopFocus = notes?.onFocus(setFocused) ?? (() => {});
    void notes?.self().then(setSelf, () => {});
    return () => {
      stopReload();
      stopSelf();
      stopFocus();
      document.documentElement.classList.remove("note-page");
    };
  }, []);

  /**
   * Wear the server's theme and skin — the chrome's tokens only, since a
   * note has no terminal whose palette would want a reload. Keyed as `App`
   * keys it, serialized, because a snapshot is a new object on every tick.
   */
  const appearance = snapshot?.appearance;
  const styles = snapshot?.styles;
  const appearanceKey = appearance
    ? JSON.stringify(appearance) + (styles?.installed.map((s) => `${s.kind}/${s.id}@${s.version}`).join() ?? "")
    : null;
  useEffect(() => {
    if (!appearance) return;
    applyTheme(themeFor(appearance.themeId, styles?.themes));
    applySkin(skinFor(appearance.skinId, styles?.skins));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearanceKey]);

  const profile = snapshot?.profile ?? null;
  const present: NoteReport["present"] | null =
    !profile || !self ? null : profile.key !== self.profileKey ? "away" : locateCard(profile, self.cardId) ? "here" : "gone";
  const seen = profile && self && present !== "away" ? readNote(profile, self.cardId, snapshot?.agents ?? [], snapshot!.mascots) : null;
  const title = seen?.card?.title ?? "";
  const code = seen?.code ?? "";
  // The window's own name, which Mission Control and the accessibility tree read.
  useEffect(() => {
    document.title = title || "Note";
  }, [title]);

  /**
   * Said once the note is drawn in its theme, and again only when what is
   * said changes: what it is showing, its title, the ground under it — the
   * window behind the page is painted that colour, so a resize does not
   * flash another — and its title bar's height, which is what a folded
   * note is.
   */
  useEffect(() => {
    const notes = desktopNotes();
    if (!notes || !present) return;
    const head = root.current?.querySelector(".note-head");
    notes.report({
      present,
      title,
      code,
      profileName: present === "away" ? undefined : profile?.name,
      background: root.current ? groundOf(root.current) : undefined,
      head: head ? Math.ceil(head.getBoundingClientRect().height) : undefined,
    });
  }, [present, title, code, profile?.name, appearanceKey]);

  if (!snapshot || !self || !profile || !seen || present === "away") return null;
  const notes = desktopNotes();
  const tag = seen.tag;
  return (
    <section
      ref={root}
      className={["note", "note-window", self.collapsed ? "note-shut" : "", focused ? "note-focused" : "", tag ? "note-tagged" : ""]
        .filter(Boolean)
        .join(" ")}
      style={(tag ? { "--tag": tag } : {}) as React.CSSProperties}
      aria-label={seen.card ? `Note: ${seen.card.title}` : "Note"}
    >
      <NoteInside
        cardId={self.cardId}
        seen={seen}
        collapsed={self.collapsed}
        profile={profile}
        agents={snapshot.agents}
        head={{ title: "Drag to move" }}
        onFold={() => {
          const collapsed = !self.collapsed;
          setSelf({ ...self, collapsed });
          notes?.fold(collapsed);
        }}
        onClose={() => notes?.close()}
        onShowBoard={() => notes?.toBoard()}
        onRefer={notes?.refer ? () => notes.refer?.() : undefined}
        onEditing={noKeys}
        onLeave={() => notes?.raiseMain()}
      />
    </section>
  );
}

/** A note window has the keyboard to itself: there is no prefix and no terminal to keep it from. */
function noKeys(): void {}

/**
 * The colour an element is painted, as `#rrggbb` — read off a pixel, since
 * the note's ground is a `color-mix` and its computed value is spelt in a way
 * the desktop's `setBackgroundColor` does not read.
 */
function groundOf(element: Element): string | undefined {
  const value = getComputedStyle(element).backgroundColor;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context || !value) return undefined;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
}
