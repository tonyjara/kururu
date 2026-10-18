/**
 * The Claude and Codex allowances, as the bottom bar's left end: a gray mark
 * for whose allowance it is, a ring for each window, and the bars behind it.
 *
 * They were a section of the sidebar until 2026-10-18, a "Claude" row of rings
 * that opened into bars. The bar along the bottom is where the window's
 * standing facts went that day — the agents running at its right — and how
 * much of the allowance is gone is the same kind of fact: a glance on the way
 * past, not a thing you go and read. So the rings are on the bar, and the bars
 * open over it: on a hover with a mouse, on a tap on a phone, which has no
 * hover to give.
 *
 * A mark rather than the word, because two of these side by side are told
 * apart by whose logo it is faster than by reading, and gray because it names
 * the account and says nothing about it — the rings carry the colour. Drawn
 * here rather than taken from the skin's icon set, on `SidebarIcon`'s
 * reasoning: a product's mark is the same drawing in any chrome.
 *
 * Every measure fills rather than drains, which went the other way first.
 * Every other measure in this window climbs — the context ring on an agent
 * row, and the figure `/usage` prints in the terminal — and a reader who has
 * just parsed a ring at 80% as "nearly out" should not have to invert the next
 * gauge to learn it means the same thing. "How much have I got left" is still
 * the question somebody asks, which is why the words beside each bar and the
 * tooltips answer it; the shape carries the comparison.
 *
 * Claude's colour is the account's severity, not a threshold kururu picked —
 * three bands invented here would disagree with the warning Claude Code prints
 * in the terminal. Codex states none, so `codexusage.ts` says where its amber
 * and red begin, and says so.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UsageLimit } from "../../../shared/wire";
import { useKururu } from "../session";
import { limitLabel, limitMarks, limitTitle, resetIn, staleTitle } from "../usage";

/**
 * Both allowances, each only when there is something to say: Claude once a
 * reading has landed and the machine is signed in, Codex while it is signed
 * in here — with no rings and a sentence behind it when every window it last
 * recorded has reset since, which is what "signed in, not used lately" looks
 * like from a rollout.
 */
export function UsageChips() {
  const { usage, codexUsage } = useKururu();
  /**
   * A tick, only so the countdowns move. The numbers arrive on their own push
   * once a minute; what goes stale between pushes is the sentence beside them
   * — "resets in 2h 14m" is wrong thirty seconds later, and a reader who
   * catches it disagreeing with the clock stops trusting the bar.
   */
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const claude = usage && !usage.signedOut && usage.limits.length > 0 ? usage : null;
  if (!claude && !codexUsage) return null;
  return (
    <span className="sb-usages">
      {claude && (
        <UsageChip
          name="Claude"
          icon={<ClaudeMark />}
          limits={claude.limits}
          stale={claude.stale ? staleTitle(claude.at) : null}
          foot={claude.email}
        />
      )}
      {codexUsage && (
        <UsageChip
          name="Codex"
          icon={<OpenAIMark />}
          limits={codexUsage.limits}
          stale={null}
          foot={[codexUsage.plan && `${capitalise(codexUsage.plan)} plan`, codexUsage.at !== null && `as Codex recorded it ${when(codexUsage.at)}`]
            .filter(Boolean)
            .join(" · ") || null}
          empty={
            codexUsage.at === null
              ? "No Codex session on this Mac has recorded its limits yet."
              : `Every window it last recorded, ${when(codexUsage.at)}, has reset since. Codex writes its limits into each session, so the next Codex turn here brings them back.`
          }
        />
      )}
    </span>
  );
}

/** How long the bars stay up after the pointer leaves, so it can cross the gap into them. */
const HOVER_LEAVE_MS = 160;

/**
 * One allowance: the mark and its rings, and the bars over them.
 *
 * Open on a mouse's hover and shut when it leaves — the popover is inside the
 * same box, so moving onto it is not leaving. A press pins it instead, which
 * is the only way a phone can open it and a way for a mouse to keep it while
 * reading; a pinned one shuts on a press anywhere else or Escape. `mousedown`
 * is prevented for the drawer chips' reason: looking at the allowance must not
 * take the focus off a terminal.
 */
function UsageChip({
  name,
  icon,
  limits,
  stale,
  foot,
  empty,
}: {
  name: string;
  icon: ReactNode;
  limits: UsageLimit[];
  /** Why the numbers are not current, or null when they are. */
  stale: string | null;
  foot: string | null;
  /** What the bars say when there are none. */
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marks = limitMarks(limits);
  /**
   * The fullest window, which is the one ring a phone's bar has room for —
   * the window that will stop you first is the one worth the space. Every
   * ring is drawn and the rest are hidden by the stylesheet on a narrow
   * window, so there is one markup and no second notion of narrow here.
   */
  const fullest = limits.reduce((best, limit, i) => (limit.percent > (limits[best]?.percent ?? -1) ? i : best), 0);

  useEffect(() => {
    if (!pinned) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPinned(false);
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [pinned]);
  useEffect(() => () => {
    if (leave.current) clearTimeout(leave.current);
  }, []);

  return (
    <span
      className="sb-usage"
      ref={box}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        if (leave.current) clearTimeout(leave.current);
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse" || pinned) return;
        leave.current = setTimeout(() => setOpen(false), HOVER_LEAVE_MS);
      }}
    >
      <button
        className={`sb-usage-chip ${open ? "sb-usage-on" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          setOpen(next);
        }}
        aria-expanded={open}
        aria-label={`${name} usage`}
        title={open ? undefined : `${name} usage`}
      >
        <span className="sb-usage-mark" aria-hidden="true">
          {icon}
        </span>
        {limits.map((limit, i) => (
          <span key={`${limit.kind}:${limit.scope ?? ""}`} className={i === fullest ? "sb-usage-fullest" : "sb-usage-rest"}>
            <GaugeRing label={limitLabel(limit)} mark={marks[i] ?? ""} percent={limit.percent} severity={limit.severity} title="" />
          </span>
        ))}
        {stale && <span className="usage-stale">·</span>}
      </button>
      {open && (
        <span className="usage-pop" role="dialog" aria-label={`${name} usage`}>
          <span className="usage-pop-head">
            <span className="sb-usage-mark" aria-hidden="true">
              {icon}
            </span>
            {name}
            {stale && (
              <span className="usage-stale" title={stale}>
                ·
              </span>
            )}
          </span>
          {limits.length > 0 ? (
            <ul className="usage-list">
              {limits.map((limit) => (
                <li key={`${limit.kind}:${limit.scope ?? ""}`} className="usage-item">
                  <span className="usage-head">
                    <span className="usage-name">{limitLabel(limit)}</span>
                    {/* "97%" alone is read as 97% *left* about as often as not,
                        and the two readings are three percent apart at one end
                        of the bar and ninety-four at the other. The word is four
                        characters and removes the question. */}
                    <span className="usage-used">{Math.round(limit.percent)}% used</span>
                  </span>
                  <span
                    className="usage-bar"
                    role="meter"
                    aria-label={`${limitLabel(limit)} used`}
                    aria-valuenow={Math.round(limit.percent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    title={limitTitle(limit)}
                  >
                    <span className="usage-fill" data-severity={limit.severity} style={{ width: `${limit.percent}%` }} />
                  </span>
                  {limit.resetsAt && <span className="usage-reset">{resetIn(limit.resetsAt)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <span className="usage-pop-empty">{empty}</span>
          )}
          {stale && <span className="usage-pop-foot">{stale}</span>}
          {foot && <span className="usage-pop-foot">{foot}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * One figure as a ring, the context ring's shape: the shut form of a bar, for a
 * machine row in the sidebar and an allowance on the bottom bar alike. The mark is a letter beside it rather than a
 * word, because three words and three rings do not fit beside a name in a
 * sidebar; the tooltip carries the whole sentence.
 */
export function GaugeRing({
  label,
  mark,
  percent,
  severity,
  title,
}: {
  label: string;
  mark: string;
  percent: number;
  severity: string;
  title: string;
}) {
  const circumference = 2 * Math.PI * 5;
  const rounded = Math.round(percent);
  return (
    <span
      className="gauge-ring"
      role="meter"
      aria-label={`${label} used`}
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
      title={title}
    >
      <svg className="ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" data-severity={severity}>
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        <circle
          cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
          transform="rotate(-90 7 7)"
          strokeLinecap="round"
        />
      </svg>
      <span className="gauge-ring-label">{mark}</span>
      <span className="gauge-ring-pct">{rounded}%</span>
    </span>
  );
}

/** "14:20" today, "Jul 29" before. */
function when(at: number): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? `at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : `on ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function capitalise(word: string): string {
  return word.slice(0, 1).toUpperCase() + word.slice(1);
}

/**
 * Claude's spark — the product's mark rather than Anthropic's A, because the
 * chip is the allowance of the thing you run, as Codex's is OpenAI's knot for
 * the thing you run there.
 */
function ClaudeMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

/** OpenAI's mark, whose Codex this is. */
function OpenAIMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}
