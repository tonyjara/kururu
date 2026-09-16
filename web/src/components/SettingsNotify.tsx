/**
 * Settings → Notifications: when kururu may interrupt you, and what it sounds
 * like.
 *
 * **Picking a sound plays it.** That is the one thing in here worth defending as
 * a decision rather than an implementation: a dropdown of fourteen names like
 * `Sosumi` and `Tink` is a list of words nobody can map to a noise, so choosing
 * from it silently would mean picking at random, waiting for an agent to finish,
 * and finding out. Every row that makes a sound therefore makes it immediately —
 * the select on change, the volume slider when the drag ends — which also means
 * the browser's autoplay unlock happens inside the gesture that needed it, so
 * the first real notification is never the silent one.
 *
 * It holds nothing, like every other page here: each control sends a verb and
 * draws what comes back in the snapshot, which is what makes a sound chosen on
 * the desktop the sound the phone makes.
 *
 * The permission row is the exception to "the server owns it", and the only
 * per-device thing on the page. Whether a browser will draw a card is not
 * kururu's state and cannot be — it is granted to an origin on a device, the
 * phone and the desktop answer differently, and no verb could change it. So it
 * is read from the browser and asked for from a button, because Safari requires
 * a user activation and because a page that asks on load deserves to be refused.
 */
import { useEffect, useState } from "react";
import { NOTIFY_EVENTS, type NotifyEvent, type NotifySettings } from "../../../shared/notify";
import {
  askPermission,
  notifyPermission,
  playSound,
  testCard,
  type CardOutcome,
  type Permission,
} from "../notify";
import * as api from "../session";

/** One row of `/api/sounds`. Mirrors `SoundInfo`; a fetch, so it is untyped on arrival. */
interface Sound {
  id: string;
  name: string;
  kind: "kururu" | "system";
}

/** What each event is called on the page, and what it actually means. */
const EVENT_LABELS: Record<NotifyEvent, [string, string]> = {
  blocked: ["Waiting for you", "an agent has asked a question and stopped"],
  done: ["Finished a turn", "an agent has gone quiet after working"],
};

export function NotifySettings({ notify }: { notify: NotifySettings }) {
  const [sounds, setSounds] = useState<Sound[] | null>(null);
  const [permission, setPermission] = useState<Permission>(notifyPermission);
  /** What the last press of the test button came to. Null until somebody presses it. */
  const [outcome, setOutcome] = useState<CardOutcome | "trying" | null>(null);

  /**
   * What there is to choose from, asked once when the page opens.
   *
   * A fetch and not the snapshot, on `/api/styles`' split — it is a listing of
   * somebody else's directories, and the only thing that cannot be drawn without
   * it is this one select. Once per mount rather than once per process, because
   * the cheap way to see a file you just dropped in `~/Library/Sounds` should be
   * to close Settings and open it again.
   */
  useEffect(() => {
    let alive = true;
    fetch("/api/sounds")
      .then((res) => res.json())
      .then((body: { sounds?: Sound[] }) => alive && setSounds(body.sounds ?? []))
      .catch(() => alive && setSounds([]));
    return () => {
      alive = false;
    };
  }, []);

  const set = (patch: Partial<NotifySettings>) => api.setNotify({ ...notify, ...patch });

  const toggleEvent = (event: NotifyEvent, on: boolean) =>
    set({ events: NOTIFY_EVENTS.filter((e) => (e === event ? on : notify.events.includes(e))) });

  const ours = sounds?.filter((sound) => sound.kind === "kururu") ?? [];
  const theirs = sounds?.filter((sound) => sound.kind === "system") ?? [];
  /**
   * A saved id this machine has no file for. It still shows, selected, rather
   * than the select silently jumping to the first option — the same argument
   * `themeFor` makes about a theme that has been uninstalled: keep the choice,
   * fall back at the moment of playing, and let the row say what is wrong.
   */
  const missing = notify.sound !== "" && sounds !== null && !sounds.some((s) => s.id === notify.sound);

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Notifications</h3>
        <p className="set-note">
          An agent that wants you is the one thing kururu has to say while you are looking at
          something else. It notifies for the terminals you cannot see — the other workspace, the
          other profile, the window behind this one — and clicking the card takes you straight to
          the agent that sent it.
        </p>

        <label className="set-check set-check-row">
          <input
            type="checkbox"
            checked={notify.enabled}
            onChange={(event) => set({ enabled: event.target.checked })}
          />
          Notify me
        </label>

        <Permissions permission={permission} onAsk={() => void askPermission().then(setPermission)} />
      </section>

      <fieldset className="set-section set-fieldset" disabled={!notify.enabled}>
        <h3 className="set-h">What for</h3>
        {NOTIFY_EVENTS.map((event) => (
          <label key={event} className="set-check set-check-row">
            <input
              type="checkbox"
              checked={notify.events.includes(event)}
              onChange={(e) => toggleEvent(event, e.target.checked)}
            />
            {EVENT_LABELS[event][0]}
            <span className="set-note set-note-inline">— {EVENT_LABELS[event][1]}</span>
          </label>
        ))}
        <label className="set-check set-check-row">
          <input
            type="checkbox"
            checked={notify.whenVisible}
            onChange={(event) => set({ whenVisible: event.target.checked })}
          />
          Also for a terminal already on screen
        </label>
        <p className="set-note set-note-under">
          Off, a pane you are looking at never interrupts you — the dot and the badge have said it
          already. It is answered per device, so the desktop showing an agent does not stop the
          phone in your pocket from being the thing that buzzes.
        </p>
      </fieldset>

      <fieldset className="set-section set-fieldset" disabled={!notify.enabled}>
        <h3 className="set-h">Sound</h3>

        <label className="set-row">
          <span className="set-label">Sound</span>
          <select
            className="set-select set-select-wide"
            value={notify.sound}
            onChange={(event) => {
              const sound = event.target.value;
              set({ sound });
              // The whole reason this page exists as more than four checkboxes.
              void playSound(sound, notify.volume);
            }}
          >
            <option value="">Silent</option>
            {missing && <option value={notify.sound}>{notify.sound} (not on this machine)</option>}
            {ours.length > 0 && (
              <optgroup label="kururu">
                {ours.map((sound) => (
                  <option key={sound.id} value={sound.id}>
                    {sound.name}
                  </option>
                ))}
              </optgroup>
            )}
            {theirs.length > 0 && (
              <optgroup label="This machine">
                {theirs.map((sound) => (
                  <option key={sound.id} value={sound.id}>
                    {sound.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <p className="set-note set-note-under">
          {sounds === null
            ? "Looking for sounds…"
            : "Picking one plays it. The machine's own alert sounds are listed too — they are the " +
              "server's, converted on the way out, so the phone gets the same noise as the desktop."}
        </p>

        <label className="set-row">
          <span className="set-label">Volume</span>
          <input
            type="range"
            className="set-range"
            min={0}
            max={100}
            step={5}
            value={Math.round(notify.volume * 100)}
            onChange={(event) => set({ volume: Number(event.target.value) / 100 })}
            /**
             * Heard when the drag ends, not on every step of it. A slider that
             * played on `input` would be sixty croaks over one gesture, and the
             * thing being judged is the volume it was let go at.
             */
            onPointerUp={() => void playSound(notify.sound, notify.volume)}
            onKeyUp={() => void playSound(notify.sound, notify.volume)}
          />
          <span className="set-value">{Math.round(notify.volume * 100)}%</span>
        </label>

        <div className="set-row set-row-split">
          <span className="set-label">Try it</span>
          <button
            className="button"
            onClick={() => {
              /**
               * The whole path, not just the noise: this is the only way to find
               * out whether the *card* works on this device before an agent
               * depends on it. It goes through the same construction the real
               * thing does for exactly that reason — a test that took a shortcut
               * would pass on a device where the real thing is silent.
               *
               * After the permission and not beside it. Asking is asynchronous
               * even when the answer is already `granted`, so a test that fired
               * both at once would show no card the first time somebody pressed
               * it — which is precisely the press that is trying to find out
               * whether cards work.
               */
              setOutcome("trying");
              void askPermission().then(async (granted) => {
                setPermission(granted);
                setOutcome(
                  await testCard(
                    {
                      // No agent, so a click on it reveals nothing — which is
                      // what `reveal-agent` does with an id nothing holds anyway.
                      agentId: "",
                      event: "done",
                      title: "kururu",
                      body: "This is what a notification looks like.",
                    },
                    notify,
                  ),
                );
              });
            }}
          >
            Send a test notification
          </button>
        </div>
        <Tried outcome={outcome} />
      </fieldset>
    </div>
  );
}

/**
 * What the test button found out, in the words each answer deserves.
 *
 * The reason this exists at all is that the page's own permission is not the
 * permission that decides. In the Electron window `Notification.permission` is
 * `granted` always — Electron asks nobody — while the authorisation that governs
 * is macOS's, against the *bundle*, and no API on this side can read it. So a
 * test that reported "permission granted, sent" was capable of saying everything
 * is fine to somebody sitting in front of a window that has never shown a card,
 * which is the one situation the button exists for.
 *
 * Hence the deliberate hedge on success: it says the browser *accepted* it, not
 * that a banner appeared, and then names who is left to blame. Claiming a banner
 * nobody saw is how the last version of this cost a morning.
 */
function Tried({ outcome }: { outcome: CardOutcome | "trying" | null }) {
  if (outcome === null) return null;
  if (outcome === "trying") return <p className="set-note set-note-under">Sending…</p>;
  if (outcome.ok) {
    return (
      <p className="set-note set-note-under">
        Sent, and the browser says it drew it. If no banner appeared, it was stopped after that
        point — by the system rather than by kururu. On macOS: check that kururu is allowed in
        System Settings → Notifications with its style set to Banners or Alerts rather than None,
        and that no Focus is switched on. The sound is unaffected by either, which is why you can
        hear this one and not see it.
      </p>
    );
  }
  return (
    <p className="set-note set-note-under">
      {outcome.reason === "unsupported" ? (
        <>No card: this browser has none to give. The sound is the whole of the notification here.</>
      ) : outcome.reason === "blocked" ? (
        <>
          No card: they are blocked for this address, and a page is not allowed to ask again — the
          browser's own site settings are the only way back. On an iPhone, add kururu to the home
          screen first: Safari only offers notifications to an installed app.
        </>
      ) : outcome.reason === "unasked" ? (
        <>No card: nothing has been granted yet. Use “Allow notification cards” above.</>
      ) : outcome.reason === "threw" ? (
        <>The browser refused to raise it{outcome.detail ? `: ${outcome.detail}` : "."}</>
      ) : (
        <>
          The browser took the card and then never reported drawing it, which is what a platform
          silently dropping it looks like from in here. On macOS that is the bundle's notification
          authorisation — check kururu in System Settings → Notifications, and that no Focus is on.
        </>
      )}
    </p>
  );
}

/**
 * Whether this browser will draw a card, and the one button that can change it.
 *
 * Four states and each needs different words, because the consequence of each is
 * different and only one of them is a thing to act on. The one worth getting
 * right is `denied`: a permission the browser is refusing cannot be re-asked
 * from a page — only from its site settings — so the row says where to go, and
 * says the part that is actually reassuring, which is that the sound still
 * plays. Half a notification is most of one when the window is on screen.
 */
function Permissions({ permission, onAsk }: { permission: Permission; onAsk: () => void }) {
  if (permission === "granted") return null;
  return (
    <p className="set-note set-note-under">
      {permission === "unsupported" ? (
        <>
          This browser will not show notification cards. The sound still plays, which on a phone
          that is in your pocket is the half that was doing the work.
        </>
      ) : permission === "denied" ? (
        <>
          Notification cards are blocked for this address — the sound still plays, and the cards
          come back if you allow them in the browser's site settings. On an iPhone, add kururu to
          the home screen first: Safari only offers notifications to an installed app.
        </>
      ) : (
        <>
          <button className="button set-button-inline" onClick={onAsk}>
            Allow notification cards
          </button>{" "}
          Without them kururu can still make the sound, but nothing says which agent it was about.
        </>
      )}
    </p>
  );
}
