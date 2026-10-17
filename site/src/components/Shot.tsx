/**
 * A screenshot of the real app in a window frame. The frame is drawn here
 * rather than baked into the image, so the same capture serves the hero and a
 * section, and width and height are always given so nothing jumps as it loads.
 */
export function Shot({
  src,
  srcSet,
  sizes = "(min-width: 1200px) 680px, (min-width: 900px) 58vw, 100vw",
  alt,
  width,
  height,
  title,
  eager = false,
  className = "",
}: {
  src: string;
  srcSet?: string;
  sizes?: string;
  alt: string;
  width: number;
  height: number;
  title?: string;
  eager?: boolean;
  className?: string;
}) {
  return (
    <figure className={`shot ${className}`}>
      <div className="shot-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        {title ? <em>{title}</em> : null}
      </div>
      <img
        src={src}
        srcSet={srcSet}
        sizes={srcSet ? sizes : undefined}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        {...(eager ? { fetchPriority: "high" as const } : {})}
      />
    </figure>
  );
}

/** A phone-shaped frame, for the captures taken at a phone's width. */
export function PhoneShot({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  return (
    <figure className="phone">
      <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" />
    </figure>
  );
}
