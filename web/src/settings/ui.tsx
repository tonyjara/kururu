/**
 * The language Settings is written in: every block a page may be built from,
 * and nothing a page may build for itself.
 *
 * Settings had seventeen pages written over a year by whoever needed one, and
 * each had its own idea of where a heading went, what a checkbox looked like
 * beside a paragraph, and how a button asked "are you sure". Once you had
 * learned one page you had learned one page. So the pages are now forbidden
 * to lay anything out: a page is a stack of groups, a group is a card of rows,
 * and a row is a label on the left and one control on the right, chosen from
 * the kinds below. Learn the row and you have read every page.
 *
 * The rules the blocks enforce, so that no page has to remember them:
 *
 * - **A label is a few words and a hint is one line.** Anything longer goes in
 *   a `Details`, folded, because a paragraph in the flow is a paragraph every
 *   visitor reads again.
 * - **Every destructive thing asks the same way.** A `DangerButton` turns into
 *   its own question in place — the sentence, Cancel, and the confirm in the
 *   danger ink — so nothing in Settings opens a dialog over the dialog, and
 *   nothing destroys on a first press.
 * - **Typing stands the window's keyboard down.** `useTyping` is spread on
 *   every field; it counts rather than toggles, so focus moving from one box
 *   straight into the next cannot flip the keyboard back on under the second,
 *   and a field that unmounts while focused gives its count back.
 * - **A control sends a verb and draws the snapshot.** None of this holds the
 *   setting it edits; `TextBox` holds the characters being typed, for exactly
 *   as long as they are being typed, and that is the one exception.
 *
 * Nothing in here knows what a theme or a channel is. The pages do, and they
 * say it in these words.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../components/Icon";

// ---------------------------------------------------------------------------
// Typing, and the window's keyboard
// ---------------------------------------------------------------------------

const EditingContext = createContext<(on: boolean) => void>(() => undefined);

/**
 * The dialog's one connection to `App.tsx`'s keyboard: a counter of how many
 * things inside are taking typing. Counted, not set, for the reason the old
 * Profiles page counted — a box per profile and focus moves from one straight
 * into the next, and a boolean would let the blur of the box you left switch
 * the keyboard on under the box you entered. Cleared when the dialog goes,
 * because a field focused at that moment never blurs.
 */
export function EditingScope({ onEditing, children }: { onEditing: (on: boolean) => void; children: ReactNode }) {
  const count = useRef(0);
  const tell = useCallback(
    (on: boolean) => {
      count.current = Math.max(0, count.current + (on ? 1 : -1));
      onEditing(count.current > 0);
    },
    [onEditing],
  );
  useEffect(() => () => onEditing(false), [onEditing]);
  return <EditingContext.Provider value={tell}>{children}</EditingContext.Provider>;
}

/** For a capture that is not a field — a key being chosen. Balanced by the caller's effect cleanup. */
export function useEditing(): (on: boolean) => void {
  return useContext(EditingContext);
}

/**
 * The two handlers every field spreads. Idempotent per field, and the field
 * gives its count back if it unmounts while focused — a row that disappears
 * under the caret (a pairing panel closing, say) must not leave the window
 * with its keyboard switched off and nothing on screen to blame.
 */
export function useTyping(): { onFocus: () => void; onBlur: () => void } {
  const tell = useEditing();
  const on = useRef(false);
  useEffect(
    () => () => {
      if (on.current) tell(false);
    },
    [tell],
  );
  return {
    onFocus: () => {
      if (on.current) return;
      on.current = true;
      tell(true);
    },
    onBlur: () => {
      if (!on.current) return;
      on.current = false;
      tell(false);
    },
  };
}

// ---------------------------------------------------------------------------
// The page and what is on it
// ---------------------------------------------------------------------------

export type Tone = "ok" | "busy" | "warn" | "bad" | "off";

/** A status mark: the three agent colours and the danger one, as a dot. */
export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return <span className={`st-dot st-dot-${tone}`} title={title} aria-hidden={!title} />;
}

/**
 * One line the server wants read before anything else on the page — a host
 * that is behind, a bot a stranger found, a registry that did not answer. At
 * the top of the body and nowhere else, so it is never mistaken for a hint.
 */
export function Banner({ tone = "warn", children, action }: { tone?: "warn" | "bad"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`st-banner st-banner-${tone}`} role="alert">
      <span className="st-banner-text">{children}</span>
      {action && <span className="st-banner-action">{action}</span>}
    </div>
  );
}

/**
 * The only container. A heading, a card of rows, a footnote — and a page is
 * nothing but a column of these. `disabled` dims the whole card through a
 * real `<fieldset disabled>`, which is what makes the rows under a switch stop
 * taking input rather than merely look as if they had.
 */
export function Group({
  title,
  foot,
  disabled,
  children,
  className,
}: {
  title?: ReactNode;
  foot?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`st-group${className ? ` ${className}` : ""}`}>
      {title && <h3 className="st-group-h">{title}</h3>}
      <fieldset className="st-card" disabled={disabled}>
        {children}
      </fieldset>
      {foot && <p className="st-foot">{foot}</p>}
    </section>
  );
}

/**
 * A row: the label and its hint on the left, one control on the right. The
 * grid is the same on every row of every page, which is what lets the eye run
 * down a column of controls. `wide` drops the control under the label for one
 * that needs the width — a text field, a long select — and on a phone every
 * field does that.
 */
export function Row({
  label,
  hint,
  wide,
  children,
  className,
  as: Tag = "div",
}: {
  label: ReactNode;
  hint?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
  className?: string;
  as?: "div" | "label";
}) {
  return (
    <Tag className={`st-row${wide ? " st-row-wide" : ""}${className ? ` ${className}` : ""}`}>
      <span className="st-row-text">
        <span className="st-label">{label}</span>
        {hint && <span className="st-hint">{hint}</span>}
      </span>
      {children !== undefined && children !== null && <span className="st-ctl">{children}</span>}
    </Tag>
  );
}

/** A switch. On or off and nothing else; what it gates sits under it in the same card. */
export function Toggle({
  label,
  hint,
  on,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint} as="label" className="st-row-toggle">
      <input
        type="checkbox"
        className="st-switch"
        role="switch"
        aria-checked={on}
        checked={on}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </Row>
  );
}

/**
 * A small choice, every option visible: a segmented control. Four at most;
 * past that it is a `Select`, because five segments on a phone is a row that
 * wraps, and a wrapped segment reads as two controls.
 */
export function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: T;
  options: ReadonlyArray<readonly [T, string] | readonly [T, string, string]>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint}>
      <Segments value={value} options={options} onChange={onChange} disabled={disabled} label={typeof label === "string" ? label : undefined} />
    </Row>
  );
}

/** The segmented control on its own, for a row that holds something beside it. */
export function Segments<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string] | readonly [T, string, string]>;
  onChange: (value: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <span className="st-seg" role="radiogroup" aria-label={label}>
      {options.map(([id, text, title]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={`st-seg-btn${value === id ? " st-seg-on" : ""}`}
          title={title}
          disabled={disabled}
          onClick={() => value !== id && onChange(id)}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

/** A select, for a choice too long to see whole. */
export function Select({
  label,
  hint,
  value,
  onChange,
  children,
  wide,
  disabled,
  ariaLabel,
  onPointerDown,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  wide?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onPointerDown?: () => void;
}) {
  return (
    <Row label={label} hint={hint} wide={wide} as="label">
      <select
        className="st-select"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </Row>
  );
}

/**
 * A text box that follows the server while nobody is typing in it, and stops
 * following the moment somebody is. Commits on blur and on Enter, reverts on
 * Escape — a name is one word, and sending it per keystroke would rename the
 * thing six times on the way to one. A controlled input fed from a round
 * trip loses the characters typed during the round trip, which is why `typing`
 * exists and why it is null rather than always a string.
 */
export function TextBox({
  value,
  onCommit,
  mono,
  short,
  className,
  onKeyDown,
  ...rest
}: {
  value: string;
  onCommit: (value: string) => void;
  mono?: boolean;
  short?: boolean;
  className?: string;
} & Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "className">) {
  const [typing, setTyping] = useState<string | null>(null);
  const reverting = useRef(false);
  const typingProps = useTyping();
  return (
    <input
      {...rest}
      className={`st-input${mono ? " st-input-mono" : ""}${short ? " st-input-short" : ""}${className ? ` ${className}` : ""}`}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      value={typing ?? value}
      onChange={(event) => setTyping(event.target.value)}
      onFocus={(event) => {
        setTyping(event.currentTarget.value);
        typingProps.onFocus();
      }}
      onBlur={() => {
        if (!reverting.current && typing !== null && typing !== value) onCommit(typing);
        reverting.current = false;
        setTyping(null);
        typingProps.onBlur();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          reverting.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** A text field as a row. Wide, because a name or a path wants the width. */
export function Field({
  label,
  hint,
  value,
  onCommit,
  placeholder,
  mono,
  ariaLabel,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint} wide as="label">
      <TextBox value={value} onCommit={onCommit} placeholder={placeholder} mono={mono} aria-label={ariaLabel} disabled={disabled} />
    </Row>
  );
}

/**
 * A number with its unit beside it. Clamped on commit rather than refused,
 * and the clamp is said by the box taking the clamped value — a box that
 * silently kept "900" while the server held 90 would be the one lying.
 */
export function NumField({
  label,
  hint,
  value,
  onCommit,
  min,
  max,
  unit,
  disabled,
  ariaLabel,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Row label={label} hint={hint} as="label">
      <span className="st-num">
        <TextBox
          type="number"
          inputMode="numeric"
          short
          mono
          min={min}
          max={max}
          value={String(value)}
          disabled={disabled}
          aria-label={ariaLabel}
          onCommit={(text) => {
            const n = Number(text);
            if (!Number.isFinite(n) || text.trim() === "") return;
            const clamped = Math.min(max, Math.max(min, Math.round(n)));
            if (clamped !== value) onCommit(clamped);
          }}
        />
        {unit && <span className="st-unit">{unit}</span>}
      </span>
    </Row>
  );
}

/**
 * A secret, which only ever comes in. Empty, it is a box and a Save; held, it
 * is the hint the server sends back (a prefix and the last few characters,
 * never the key), a dot for whether it works, Replace, and Remove as a danger
 * action. The key is sent once and the box is cleared; nothing here can show
 * it again, which is the design and not a limitation.
 */
export function KeyRow({
  label,
  hint,
  placeholder,
  ariaLabel,
  stored,
  onSave,
  onRemove,
  removeLabel = "Remove",
  removeAsk,
  saveLabel = "Save",
  busyLabel = "Checking…",
}: {
  label: ReactNode;
  hint?: ReactNode;
  placeholder: string;
  ariaLabel: string;
  /** What the server holds, or null for nothing yet. `text` goes before the hint: the bot the token is for. */
  stored: { hint: string; tone: Tone; text?: ReactNode } | null;
  onSave: (key: string) => Promise<unknown>;
  onRemove: () => void;
  removeLabel?: string;
  removeAsk: string;
  saveLabel?: string;
  busyLabel?: string;
}) {
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typing = useTyping();

  const save = () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    onSave(key)
      .then(() => {
        setKey("");
        setReplacing(false);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const box = (
    <span className="st-keybox">
      <input
        className="st-input st-input-mono"
        type="password"
        value={key}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => setKey(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape" && stored) setReplacing(false);
        }}
        {...typing}
      />
      {stored && <Btn onClick={() => setReplacing(false)}>Cancel</Btn>}
      <Btn primary disabled={!key.trim() || busy} onClick={save}>
        {busy ? busyLabel : saveLabel}
      </Btn>
    </span>
  );

  if (!stored) {
    return (
      <Row label={label} hint={error ? <Outcome bad>{error}</Outcome> : hint} wide as="label">
        {box}
      </Row>
    );
  }
  return (
    <>
      <Row label={label} hint={error ? <Outcome bad>{error}</Outcome> : hint}>
        <span className={`st-readout${stored.tone === "bad" ? " st-readout-bad" : ""}`}>
          <Dot tone={stored.tone} />
          {stored.text && <span className="st-readout-v">{stored.text}</span>}
          <Mono>{stored.hint}</Mono>
        </span>
        {!replacing && <Btn onClick={() => setReplacing(true)}>Replace</Btn>}
        <DangerButton label={removeLabel} ask={removeAsk} onConfirm={onRemove} />
      </Row>
      {replacing && (
        <Row label="New key" wide as="label">
          {box}
        </Row>
      )}
    </>
  );
}

/** A range with its value beside it, fixed-width so the row does not shuffle as the digits change. */
export function Slider({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  onRelease,
  format,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  /** Heard when the drag ends, for a slider whose value is a sound. */
  onRelease?: () => void;
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint} as="label">
      <span className="st-slider">
        <input
          type="range"
          className="st-range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={onRelease}
          onKeyUp={onRelease}
        />
        <span className="st-value">{format ? format(value) : String(value)}</span>
      </span>
    </Row>
  );
}

/** A value that is read, not set: a dot and a few words, and an action beside it if there is one. */
export function Readout({
  label,
  hint,
  value,
  tone,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: ReactNode;
  tone?: Tone;
  children?: ReactNode;
}) {
  return (
    <Row label={label} hint={hint}>
      <span className={`st-readout${tone === "bad" ? " st-readout-bad" : ""}`}>
        {tone && <Dot tone={tone} />}
        <span className="st-readout-v">{value}</span>
      </span>
      {children}
    </Row>
  );
}

/** A button, in the three weights Settings has: quiet, the page's one primary, and danger. */
export function Btn({
  children,
  onClick,
  primary,
  danger,
  disabled,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`st-btn${primary ? " st-btn-primary" : ""}${danger ? " st-btn-danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

/** A thing to do, with what came of it as the row's hint afterwards. */
export function Action({
  label,
  hint,
  button,
  onClick,
  busy,
  busyLabel,
  disabled,
  primary,
  outcome,
}: {
  label: ReactNode;
  hint?: ReactNode;
  button: string;
  onClick: () => void;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  primary?: boolean;
  outcome?: { text: ReactNode; bad?: boolean } | null;
}) {
  return (
    <Row label={label} hint={outcome ? <Outcome bad={outcome.bad}>{outcome.text}</Outcome> : hint}>
      <Btn onClick={onClick} disabled={disabled || busy} primary={primary}>
        {busy ? (busyLabel ?? "Working…") : button}
      </Btn>
    </Row>
  );
}

/** What an action came to, in the hint's place: the text colour for news, the danger colour for a failure. */
export function Outcome({ bad, children }: { bad?: boolean; children: ReactNode }) {
  return (
    <span className={`st-outcome${bad ? " st-outcome-bad" : ""}`} role={bad ? "alert" : "status"}>
      {children}
    </span>
  );
}

/**
 * The one shape every destructive control has: a button in the danger ink
 * that, pressed, becomes its own question in place — the sentence, Cancel,
 * and the confirm. In place rather than a dialog, because Settings is already
 * modal and a confirm over a confirm is a stack; and never on the first press,
 * because the thing on the other side is somebody's agent or somebody's file.
 */
export function DangerButton({
  label,
  ask,
  confirm,
  onConfirm,
  disabled,
  busy,
  busyLabel,
}: {
  label: string;
  /** The question, as a sentence: "Delete it, ending 3 agents?" */
  ask: string;
  /** The confirm's word. The label again when absent. */
  confirm?: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (busy) {
    return (
      <Btn danger disabled>
        {busyLabel ?? "Working…"}
      </Btn>
    );
  }
  if (!asking) {
    return (
      <Btn danger disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Btn>
    );
  }
  return (
    <span className="st-ask" role="alertdialog" aria-label={ask}>
      <span className="st-ask-q">{ask}</span>
      <Btn onClick={() => setAsking(false)}>Cancel</Btn>
      <button
        type="button"
        className="st-btn st-btn-danger st-btn-danger-sure"
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setAsking(false);
          }
        }}
      >
        {confirm ?? label}
      </button>
    </span>
  );
}

/** A destructive thing as a row. The last row on its page, by the rule in the header. */
export function Danger({
  label,
  hint,
  button,
  ask,
  confirm,
  onConfirm,
  disabled,
  busy,
  busyLabel,
}: {
  label: ReactNode;
  hint?: ReactNode;
  button: string;
  ask: string;
  confirm?: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <Row label={label} hint={hint} className="st-row-danger">
      <DangerButton label={button} ask={ask} confirm={confirm} onConfirm={onConfirm} disabled={disabled} busy={busy} busyLabel={busyLabel} />
    </Row>
  );
}

/** A way out to somebody else's site, marked as one. */
export function Link({ label, hint, href, text }: { label: ReactNode; hint?: ReactNode; href: string; text: string }) {
  return (
    <Row label={label} hint={hint}>
      <a className="st-link" href={href} target="_blank" rel="noreferrer noopener">
        {text}
        <Icon name="external" />
      </a>
    </Row>
  );
}

/** A link inside a hint or a detail, in the same clothes. */
export function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="st-a" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** A fragment of terminal in prose: a path, a key's tail, a flag. */
export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="st-mono" title={title}>
      {children}
    </code>
  );
}

// ---------------------------------------------------------------------------
// Lists, galleries, steps, details, tiles
// ---------------------------------------------------------------------------

/**
 * One of several: a chip or a dot, a name and a second line, and what can be
 * done to it at the end. The actions are icon buttons or a danger button; a
 * row that is itself a choice says so with `on` and takes `onClick`.
 */
export function Item({
  lead,
  name,
  sub,
  on,
  onClick,
  children,
  className,
  title,
}: {
  lead?: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  on?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  const pick = onClick ? { onClick, role: "button", tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && onClick() } : {};
  return (
    <div className={`st-item${on ? " st-item-on" : ""}${onClick ? " st-item-pick" : ""}${className ? ` ${className}` : ""}`} title={title}>
      {lead !== undefined && <span className="st-item-lead">{lead}</span>}
      <span className="st-item-text" {...pick}>
        <span className="st-item-name">{name}</span>
        {sub && <span className="st-item-sub">{sub}</span>}
      </span>
      {children && <span className="st-item-actions">{children}</span>}
    </div>
  );
}

/** A small button that is an icon: forget, play, the default star. */
export function IconBtn({
  icon,
  glyph,
  label,
  onClick,
  danger,
  on,
  disabled,
}: {
  icon?: "close" | "play" | "restart" | "external" | "more" | "add" | "edit" | "stop";
  /** A character instead of an icon, for the one mark the icon set has no drawing of. */
  glyph?: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  on?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`st-iconbtn${danger ? " st-iconbtn-danger" : ""}${on ? " st-iconbtn-on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon ? <Icon name={icon} /> : glyph}
    </button>
  );
}

/** The last row of a list: a box and a button that makes another. */
export function AddRow({
  placeholder,
  onAdd,
  label = "Add",
  ariaLabel,
  disabled,
  mono,
}: {
  placeholder: string;
  onAdd: (value: string) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  const [value, setValue] = useState("");
  const typing = useTyping();
  const add = () => {
    if (!value.trim() || disabled) return;
    onAdd(value.trim());
    setValue("");
  };
  return (
    <div className="st-item st-item-add">
      <input
        className={`st-input${mono ? " st-input-mono" : ""}`}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        {...typing}
      />
      <Btn onClick={add} disabled={disabled || !value.trim()}>
        {label}
      </Btn>
    </div>
  );
}

/**
 * The bar over a long list: which shelf, and a filter. One line, wrapping on
 * a phone with the box dropping under the pills rather than squeezed beside
 * them. The pills are a `Segments`, which is the same control as a choice row
 * because it is one — over the list rather than over a setting.
 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="st-toolbar">{children}</div>;
}

/**
 * The filter box. Escape empties it before it closes the dialog, which is what
 * somebody with a full box means by it; whoever owns the value stands the
 * keyboard down while there is something in it to lose.
 */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <input
      className="st-search"
      type="search"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !value) return;
        event.stopPropagation();
        onChange("");
      }}
    />
  );
}

/** What a card says when its list is empty: one line, in the hint's voice, where a row would be. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="st-empty">{children}</p>;
}

/** Pictures to choose between, in a grid that wraps. The chosen one wears the accent ring. */
export function Gallery({ children, size = "md", label }: { children: ReactNode; size?: "sm" | "md" | "lg"; label?: string }) {
  return (
    <div className={`st-gallery st-gallery-${size}`} role={label ? "radiogroup" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

/** One picture in a gallery. The picture draws itself; this is the frame, the name and the ring. */
export function Card({
  picture,
  name,
  sub,
  on,
  onClick,
  style,
  className,
  title,
}: {
  picture: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  on: boolean;
  onClick: () => void;
  style?: CSSProperties;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`st-pic${on ? " st-pic-on" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      onClick={onClick}
      title={title}
    >
      <span className="st-pic-shot">{picture}</span>
      <span className="st-pic-text">
        <span className="st-pic-name">{name}</span>
        {sub && <span className="st-pic-sub">{sub}</span>}
      </span>
    </button>
  );
}

/** A walkthrough. The steps are its rows. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="st-steps">{children}</ol>;
}

/**
 * One step: its number until the server says it is done, then a tick. A done
 * step folds to its title, because what is inside it has been done and the
 * person is here for the next one; it opens again on a press, since a token is
 * replaced in step two however long ago it was first given.
 */
export function Step({ n, done, title, line, children }: { n: number; done: boolean; title: string; line?: ReactNode; children?: ReactNode }) {
  const [opened, setOpened] = useState<boolean | null>(null);
  const open = opened ?? !done;
  return (
    <li className={`st-step${done ? " st-step-done" : ""}${open ? " st-step-open" : ""}`}>
      <button type="button" className="st-step-head" onClick={() => setOpened(!open)} aria-expanded={open}>
        <span className="st-step-n" aria-label={done ? `step ${n}, done` : `step ${n}`}>
          {done ? "✓" : n}
        </span>
        <span className="st-step-title">{title}</span>
        {line && <span className="st-step-line">{line}</span>}
      </button>
      {open && children && <div className="st-step-body">{children}</div>}
    </li>
  );
}

/** The only place a paragraph may live: folded, under a summary that says what is in it. */
export function Details({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="st-details" open={open}>
      <summary className="st-details-sum">
        <Icon name="caret" />
        <span>{summary}</span>
      </summary>
      <div className="st-details-body">{children}</div>
    </details>
  );
}

/** A paragraph inside a `Details`. */
export function P({ children }: { children: ReactNode }) {
  return <p className="st-p">{children}</p>;
}

/** A list inside a `Details`: a path and a reason each. */
export function Bullets({ items }: { items: ReadonlyArray<ReactNode> }) {
  return (
    <ul className="st-bullets">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** A row of figures. The one readout that is not a row. */
export function Tiles({ children }: { children: ReactNode }) {
  return <div className="st-tiles">{children}</div>;
}

export function Tile({ value, label, under, children }: { value: string; label: string; under?: string; children?: ReactNode }) {
  return (
    <div className="st-tile">
      <span className="st-tile-v">{value}</span>
      <span className="st-tile-l">{label}</span>
      {under && <span className="st-tile-u">{under}</span>}
      {children && <span className="st-tile-a">{children}</span>}
    </div>
  );
}

/** "14:03" today, "Oct 11" before — the one clock every list on these pages reads. */
export function when(at: number | string): string {
  const date = new Date(at);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
