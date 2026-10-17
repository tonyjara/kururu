/**
 * The mascot, drawn off the same sprite sheet the app's badge uses rather than
 * an exported GIF: one 20 KB sheet covers every pose, and `steps()` gives the
 * hard frame cuts pixel art needs where a GIF would be a second asset per pose.
 *
 * Row 7 faces right and is the row the app icon is cut from. Columns 0–3 idle,
 * 4–7 croak, 8–11 jump, 12–15 hop — `assets/spritesheets/guide.png` labels them.
 */
type Pose = "idle" | "croak" | "hop";

const START: Record<Pose, number> = { idle: 0, croak: 4, hop: 12 };

export function Frog({ pose = "idle", scale = 3, className = "" }: { pose?: Pose; scale?: number; className?: string }) {
  const cell = 32 * scale;
  return (
    <span
      aria-hidden="true"
      className={`frog frog-${pose} ${className}`}
      style={
        {
          "--cell": `${cell}px`,
          "--start": `${-START[pose] * cell}px`,
          "--end": `${-(START[pose] + 4) * cell}px`,
          "--row": `${-7 * cell}px`,
        } as React.CSSProperties
      }
    />
  );
}
