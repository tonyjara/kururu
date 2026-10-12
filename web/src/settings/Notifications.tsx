/**
 * Settings → System → Notifications: when kururu may interrupt you, and what
 * it sounds like.
 *
 * **Picking a sound plays it.** A dropdown of fourteen names like `Sosumi`
 * and `Tink` is a list of words nobody can map to a noise, so every row that
 * makes a sound makes it immediately — which also means the browser's autoplay
 * unlock happens inside the gesture that needed it.
 *
 * The permission is the one per-device thing on the page: whether a browser
 * will draw a card is granted to an origin on a device, the phone and the
 * desktop answer differently, and no verb could change it. So it is read from
 * the browser and asked for from a button, because Safari requires a user
 * activation and a page that asks on load deserves to be refused.
 */
import { useEffect, useState } from "react";
import { NOTIFY_EVENTS, type NotifyEvent, type NotifySettings } from "../../../shared/notify";
import { askPermission, notifyPermission, playSound, testCard, type CardOutcome, type Permission } from "../notify";
import * as api from "../session";
import { Action, Group, Readout, Select, Slider, Toggle } from "./ui";

interface Sound {
  id: string;
  name: string;
  kind: "kururu" | "system";
}

const EVENT_LABELS: Record<NotifyEvent, [string, string]> = {
  blocked: ["Waiting for you", "An agent has asked a question and stopped."],
  done: ["Finished a turn", "An agent has gone quiet after working."],
};

export function NotificationsPage({ notify }: { notify: NotifySettings }) {
  const [sounds, setSounds] = useState<Sound[] | null>(null);
  const [permission, setPermission] = useState<Permission>(notifyPermission);
  const [outcome, setOutcome] = useState<CardOutcome | "trying" | null>(null);

  /** Asked once per mount: the cheap way to see a file you just dropped in `~/Library/Sounds` is to close Settings and open it again. */
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
  const toggleEvent = (event: NotifyEvent, on: boolean) => set({ events: NOTIFY_EVENTS.filter((e) => (e === event ? on : notify.events.includes(e))) });

  const ours = sounds?.filter((sound) => sound.kind === "kururu") ?? [];
  const theirs = sounds?.filter((sound) => sound.kind === "system") ?? [];
  /** A saved id this machine has no file for still shows, selected, rather than the select jumping to the first option. */
  const missing = notify.sound !== "" && sounds !== null && !sounds.some((s) => s.id === notify.sound);

  return (
    <>
      <Group title="Notifications" foot="For the terminals you cannot see. Clicking the card goes to the agent that sent it.">
        <Toggle label="Notify me" on={notify.enabled} onChange={(enabled) => set({ enabled })} />
        <Cards permission={permission} onAsk={() => void askPermission().then(setPermission)} />
      </Group>

      <Group title="What for" disabled={!notify.enabled}>
        {NOTIFY_EVENTS.map((event) => (
          <Toggle key={event} label={EVENT_LABELS[event][0]} hint={EVENT_LABELS[event][1]} on={notify.events.includes(event)} onChange={(on) => toggleEvent(event, on)} />
        ))}
        <Toggle label="Also when on screen" hint="Per device: the desktop showing an agent does not silence the phone." on={notify.whenVisible} onChange={(whenVisible) => set({ whenVisible })} />
      </Group>

      <Group title="Sound" disabled={!notify.enabled}>
        <Select
          label="Sound"
          hint={sounds === null ? "Looking for sounds…" : "Picking one plays it. The machine's own alert sounds are here too."}
          value={notify.sound}
          onChange={(sound) => {
            set({ sound });
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
        </Select>
        <Slider
          label="Volume"
          min={0}
          max={100}
          step={5}
          value={Math.round(notify.volume * 100)}
          format={(n) => `${n}%`}
          onChange={(n) => set({ volume: n / 100 })}
          /* Heard when the drag ends, not on every step of it. */
          onRelease={() => void playSound(notify.sound, notify.volume)}
        />
        <Action
          label="Try it"
          hint="The whole path, card and sound, on this device."
          button="Send a test"
          busy={outcome === "trying"}
          busyLabel="Sending…"
          outcome={tried(outcome)}
          onClick={() => {
            /**
             * After the permission and not beside it: asking is asynchronous
             * even when the answer is already `granted`, so a test that fired
             * both at once would show no card the first time.
             */
            setOutcome("trying");
            void askPermission().then(async (granted) => {
              setPermission(granted);
              setOutcome(await testCard({ agentId: "", event: "done", title: "kururu", body: "This is what a notification looks like." }, notify));
            });
          }}
        />
      </Group>
    </>
  );
}

/**
 * Whether this browser will draw a card, and the one button that can change it.
 * `denied` cannot be re-asked from a page, so the row says where to go and
 * the reassuring part: the sound still plays.
 */
function Cards({ permission, onAsk }: { permission: Permission; onAsk: () => void }) {
  if (permission === "granted") return <Readout label="Cards" tone="ok" value="Allowed on this device" />;
  if (permission === "unsupported") return <Readout label="Cards" tone="off" value="This browser has none" hint="The sound still plays, which on a phone in your pocket is the half doing the work." />;
  if (permission === "denied") {
    return <Readout label="Cards" tone="bad" value="Blocked for this address" hint="Allow them in the browser's site settings. On an iPhone, add kururu to the home screen first." />;
  }
  return <Action label="Cards" hint="Without them kururu makes the sound, but nothing says which agent it was about." button="Allow" primary onClick={onAsk} />;
}

/**
 * What the test found out, hedged on success: in the Electron window the
 * permission is `granted` always while the authorisation that governs is
 * macOS's, against the bundle, which no API on this side can read. So it says
 * the browser accepted it, and names who is left to blame.
 */
function tried(outcome: CardOutcome | "trying" | null): { text: string; bad?: boolean } | null {
  if (outcome === null || outcome === "trying") return null;
  if (outcome.ok) return { text: "Sent, and the browser says it drew it. If no banner appeared, check System Settings → Notifications and that no Focus is on." };
  switch (outcome.reason) {
    case "unsupported":
      return { text: "No card: this browser has none to give. The sound is the whole notification here.", bad: true };
    case "blocked":
      return { text: "No card: blocked for this address. The browser's site settings are the only way back; on an iPhone, add kururu to the home screen first.", bad: true };
    case "unasked":
      return { text: "No card: nothing granted yet. Press Allow above.", bad: true };
    case "threw":
      return { text: `The browser refused to raise it${outcome.detail ? `: ${outcome.detail}` : "."}`, bad: true };
    default:
      return { text: "The browser took the card and never reported drawing it: on macOS, check kururu in System Settings → Notifications, and that no Focus is on.", bad: true };
  }
}
