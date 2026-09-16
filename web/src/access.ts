/**
 * Turning the token in the address into a device that keeps working.
 *
 * A shared kururu wants a token from anything that is not on the machine it is
 * running on, and the only way anybody is ever going to enter one is by pointing
 * a camera at a QR code — so the code carries it as `?k=`, and this is the five
 * lines that happen once when that address is opened. The token is handed to
 * `/api/access`, which sets it as a cookie, and from that moment the browser
 * attaches it to every fetch *and to the WebSocket handshake* without anything
 * here having to remember to. That is the whole reason it is a cookie: the
 * alternative is a header added at eleven call sites, one of which would be
 * missed, and the one that was missed would be an `<img>`.
 *
 * It also works unchanged in development, where the page comes from vite and
 * only the proxied requests reach the kururu server at all — the exchange is a
 * proxied request like any other, and the cookie comes back through the proxy.
 *
 * The token is taken back out of the address bar afterwards, but **only when the
 * exchange worked**. A failure here is nearly always a server that is restarting
 * — which is exactly what turning sharing on does — and a phone left holding an
 * address with no token in it could not retry by reloading, which is the one
 * thing anybody will try.
 */
const PARAM = "k";

export function claimAccess(): Promise<void> {
  let token: string | null = null;
  try {
    token = new URL(location.href).searchParams.get(PARAM);
  } catch {
    // An address this cannot parse is not one carrying a token.
  }
  if (!token) return Promise.resolve();

  return fetch(`/api/access?${PARAM}=${encodeURIComponent(token)}`)
    .then((response) => {
      if (!response.ok) return;
      const url = new URL(location.href);
      url.searchParams.delete(PARAM);
      history.replaceState(null, "", url.toString());
    })
    .catch(() => {
      // Left in the address, so a reload is a retry.
    });
}
