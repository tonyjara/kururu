import type { ShotInfo } from "../shots";

/** The phone's breakpoint for a shot's `phone` cut, matching the single-column layout. */
const PHONE = "(max-width: 600px)";

function srcSet(shot: { name: string; wide?: boolean }, ext: "webp" | "jpg") {
  return shot.wide
    ? `/shots/${shot.name}-1200.${ext} 1200w, /shots/${shot.name}.${ext} 2400w`
    : `/shots/${shot.name}.${ext}`;
}

/**
 * The one way a screenshot is drawn: WebP for the browsers that take it, the
 * JPEG as the <img> itself for any that do not, and a phone's own cut first
 * when there is one. The <img> carries the size so nothing jumps as it loads.
 */
function Picture({ shot, sizes, eager = false }: { shot: ShotInfo; sizes?: string; eager?: boolean }) {
  const s = shot.wide ? sizes : undefined;
  return (
    <picture>
      {shot.phone ? (
        <>
          <source media={PHONE} type="image/webp" srcSet={srcSet(shot.phone, "webp")} width={shot.phone.width} height={shot.phone.height} />
          <source media={PHONE} srcSet={srcSet(shot.phone, "jpg")} width={shot.phone.width} height={shot.phone.height} />
        </>
      ) : null}
      <source type="image/webp" srcSet={srcSet(shot, "webp")} sizes={s} />
      <img
        src={shot.wide ? `/shots/${shot.name}-1200.jpg` : `/shots/${shot.name}.jpg`}
        srcSet={shot.wide ? srcSet(shot, "jpg") : undefined}
        sizes={s}
        alt={shot.alt}
        width={shot.width}
        height={shot.height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        {...(eager ? { fetchPriority: "high" as const } : {})}
      />
    </picture>
  );
}

/**
 * A screenshot of the real app in a window frame. The frame is drawn here
 * rather than baked into the image, so the same capture serves the hero and a
 * section.
 */
export function Shot({
  shot,
  sizes = "(min-width: 1200px) 680px, (min-width: 900px) 58vw, 100vw",
  title,
  eager = false,
}: {
  shot: ShotInfo;
  sizes?: string;
  title?: string;
  eager?: boolean;
}) {
  return (
    <figure className="shot">
      <div className="shot-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        {title ? <em>{title}</em> : null}
      </div>
      <Picture shot={shot} sizes={sizes} eager={eager} />
    </figure>
  );
}

/** A phone-shaped frame, for the captures taken at a phone's width. */
export function PhoneShot({ shot }: { shot: ShotInfo }) {
  return (
    <figure className="phone">
      <Picture shot={shot} />
    </figure>
  );
}
