/**
 * The marking script: what runs inside a page while the user marks it.
 *
 * Marking is done on the live page, the way Orca and Cursor do it
 * (docs/plans/browser-annotate.md, "Marking"), because a page's hover states
 * and its scrolling are half of what a person points at — a menu that opens
 * on hover, the card at the bottom of a long list — and a frozen picture has
 * neither. So this script draws the hover box, the numbered pins, a region
 * and a pen stroke *in* the page, and takes the clicks before the page sees
 * them, while the pointer's movement and the wheel are left to the page.
 *
 * **Where it runs, and why there.** In an isolated world (`kururu-marks`),
 * evaluated by main over the debugger (`desktop/marks.js`): it shares the
 * page's DOM and nothing else, so the page's scripts cannot see this script's
 * globals or call the one binding it talks to main through, and a page's CSP
 * does not apply to it. It draws in a **closed** shadow root on a host
 * element promoted to the top layer (`popover="manual"`), so no `z-index` the
 * page has goes over it, the page's CSS does not reach into it, and its
 * styles are a constructed sheet a `style-src` cannot refuse.
 *
 * **What the page can learn from it**: that a `<kururu-marks>` element is
 * there, and the pins' numbers. Never the comments, which are typed into
 * kururu's own popover and stay in main; nothing here ever holds one.
 *
 * **Written once for two hosts.** There is no Electron in it: it speaks
 * through a function named by its one argument, which is a CDP binding here
 * and would be `chrome.runtime.sendMessage` in an extension's content script,
 * and it reads only what a content script could read too.
 *
 * The pure pieces — where a pin is on a box and back, and the selectors'
 * ranking — are plain functions above `markingMain`, exported for the tests
 * and put into the page's source beside it, so the page runs the code the
 * tests ran.
 */

/** The isolated world's name, and the binding's: main's and the script's, kept here in one place. */
const WORLD = "kururu-marks";
const BINDING = "__kururuMark";

/**
 * Where a pin is, given its element's box now and the fraction of that box it
 * was put at — Velt's anchor: a pin follows its element through scrolling,
 * resizing and re-layout because it is a point *on* the element, not a point
 * on the screen.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} fx
 * @param {number} fy
 */
function pinPoint(box, fx, fy) {
  const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
  return { x: box.x + box.width * clamp(fx), y: box.y + box.height * clamp(fy) };
}

/**
 * The fraction of a box a point is at, kept inside the box: the other half of
 * `pinPoint`. A box with no width or height pins at its middle on that axis.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} x
 * @param {number} y
 */
function pinFraction(box, x, y) {
  const along = (start, length, at) => {
    if (!Number.isFinite(at) || !Number.isFinite(start) || !(length > 0)) return 0.5;
    return Math.max(0, Math.min(1, (at - start) / length));
  };
  return { fx: along(box.x, box.width, x), fy: along(box.y, box.height, y) };
}

/**
 * The selectors for an element, best first — by how long each survives the
 * code changing under it (Velt's ranking): a test id or an id, then a role
 * and name, then an attribute, then classes, and a position in the tree last.
 * One that matched exactly one element when the mark was made goes ahead of
 * every one that did not, whatever its kind, since a selector that finds two
 * things finds the wrong one half the time. Repeats are dropped; the first
 * `max` are kept.
 *
 * @param {{kind: string, value: string, unique: boolean}[]} candidates
 * @param {number} [max]
 */
function rankSelectors(candidates, max = 5) {
  const ORDER = ["testid", "id", "role", "attr", "class", "path"];
  const rank = (kind) => {
    const at = ORDER.indexOf(kind);
    return at === -1 ? ORDER.length : at;
  };
  const seen = new Set();
  return candidates
    .filter((c) => c && typeof c.value === "string" && c.value && !seen.has(c.value) && seen.add(c.value))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(b.c.unique) - Number(a.c.unique) || rank(a.c.kind) - rank(b.c.kind) || a.i - b.i)
    .slice(0, max)
    .map(({ c }) => ({ kind: c.kind, value: c.value, unique: c.unique === true }));
}

/**
 * Whether a class or an id looks made by a tool rather than written by a
 * person — a CSS-in-JS hash, React's `useId`, a long run of digits — and so
 * will not be the same after the next build, which makes it a poor thing to
 * find an element by.
 *
 * @param {string} name
 */
function looksGenerated(name) {
  return (
    !name ||
    /^(?::|radix-|headlessui-|react-|mui-|ember\d|ng-)/.test(name) ||
    /^(?:css|sc|jsx|emotion|svelte|astro|tw)-[a-z0-9]{4,}$/i.test(name) ||
    /^_[a-zA-Z0-9]{5,}$/.test(name) ||
    /[0-9]{4,}/.test(name) ||
    /^[a-z]{1,3}[0-9][a-z0-9]{3,}$/i.test(name) ||
    /__[a-zA-Z0-9]{5}$/.test(name)
  );
}

/**
 * The script itself. Everything it keeps is in this closure, in the
 * isolated world; `globalThis.__kururuMarks` is that world's global, which
 * the page's world does not share, and is how main calls in.
 *
 * @param {string} binding
 */
function markingMain(binding) {
  const G = globalThis;
  if (G.__kururuMarks) return;

  /** The attributes read off an element: the ones that find it or say what it is, never one that holds a value. */
  const ATTRS = ["id", "class", "role", "name", "type", "href", "src", "alt", "title", "placeholder", "for", "data-testid", "data-test", "data-cy", "data-test-id", "data-qa"];
  const keepAttr = (name) => ATTRS.includes(name) || (name.startsWith("aria-") && name !== "aria-valuenow" && name !== "aria-valuetext");
  const STYLES = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "display", "position", "margin", "padding", "gap", "width", "height"];
  const TEXT_MAX = 200;
  const SELECTION_MAX = 2000;
  const HTML_MAX = 4096;
  const ELEMENTS_MAX = 6;
  const PIN = 22;

  const send = (message) => {
    try {
      G[binding](JSON.stringify(message));
    } catch {
      // No binding: the world outlived its main, or this is a page main never set up. Nothing to tell.
    }
  };

  // -------------------------------------------------------------------------
  // The layer
  // -------------------------------------------------------------------------

  const CSS_TEXT = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; font: 600 12px/1 -apple-system, system-ui, sans-serif; }
    .hover { position: fixed; box-sizing: border-box; border: 2px solid #ff4fa3; background: rgba(255, 79, 163, 0.08); border-radius: 3px; display: none; }
    .hover-tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 3px; padding: 3px 6px; border-radius: 4px; background: #ff4fa3; color: #fff; white-space: nowrap; font-weight: 600; font-size: 11px; }
    .hover-tag.under { bottom: auto; top: 100%; margin: 3px 0 0; }
    .pending { position: fixed; box-sizing: border-box; border: 2px dashed #ff4fa3; border-radius: 3px; }
    .region { position: fixed; box-sizing: border-box; border: 2px dashed #ff4fa3; background: rgba(255, 79, 163, 0.06); border-radius: 2px; }
    .pin { position: fixed; width: ${PIN}px; height: ${PIN}px; margin: -${PIN / 2}px 0 0 -${PIN / 2}px; border-radius: 50% 50% 50% 0; background: #ff4fa3; color: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(0,0,0,.35), 0 0 0 2px #fff; font-size: 11px; }
    .pin.lost { background: #8a8a8a; }
    canvas { position: fixed; inset: 0; width: 100%; height: 100%; }
  `;

  let host = null;
  let root = null;
  let layer = null;
  let hoverBox = null;
  let hoverTag = null;
  let canvas = null;
  let ctx = null;

  const important = (el, styles) => {
    for (const [key, value] of Object.entries(styles)) el.style.setProperty(key, value, "important");
  };

  function build() {
    host = document.createElement("kururu-marks");
    host.setAttribute("popover", "manual");
    // Inline and important, through the CSSOM, which a page's CSP does not
    // police: a page rule like `html > * { display: none }` must not hide it.
    important(host, {
      all: "initial",
      display: "block",
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      "pointer-events": "none",
      "z-index": "2147483647",
      "max-width": "none",
      "max-height": "none",
      opacity: "1",
      visibility: "visible",
      transform: "none",
      filter: "none",
      contain: "none",
    });
    root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = CSS_TEXT;
      root.append(style);
    }
    layer = document.createElement("div");
    layer.className = "layer";
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d");
    hoverBox = document.createElement("div");
    hoverBox.className = "hover";
    hoverTag = document.createElement("div");
    hoverTag.className = "hover-tag";
    hoverBox.append(hoverTag);
    layer.append(canvas, hoverBox);
    root.append(layer);
  }

  /** On the page, in the top layer; put back if the page took it out. */
  function mount() {
    const top = document.documentElement;
    if (!top) return;
    if (!host) build();
    if (host.parentNode !== top) {
      top.appendChild(host);
      promote();
    } else if (!isOpen()) promote();
  }

  function unmount() {
    if (host && host.parentNode) {
      try {
        host.hidePopover();
      } catch {
        // Not open.
      }
      host.remove();
    }
  }

  function isOpen() {
    try {
      return host.matches(":popover-open");
    } catch {
      return false;
    }
  }

  /** To the top of the top layer again: a dialog or popover the page opened after ours would be above it. */
  function promote() {
    if (!host || !host.isConnected) return;
    try {
      if (isOpen()) host.hidePopover();
      host.showPopover();
    } catch {
      // A browser with no popovers draws it at the highest z-index instead.
    }
  }

  const shown = () => state.mode || state.pins.size > 0;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * @type {{ mode: boolean, tool: string, shape: string, hovered: Element | null, below: Element[], pointer: { x: number, y: number },
   *   pending: Element[], drag: { tool: string, shape: string, points: { x: number, y: number, w: number }[] } | null,
   *   pins: Map<string, any>, looping: boolean, lastFind: number }}
   */
  const state = {
    mode: false,
    /** "element" | "region" | "pen" */
    tool: "element",
    /** "free" | "arrow" | "ellipse" */
    shape: "free",
    hovered: null,
    /** Elements walked down from with ↑, for ↓ to come back through. */
    below: [],
    /** The last pointer position, in the top window's viewport. */
    pointer: { x: -1, y: -1 },
    /** Shift-clicked elements waiting for the click that makes them one mark. */
    pending: [],
    /** A region or a stroke being drawn. */
    drag: null,
    /** k → pin. */
    pins: new Map(),
    looping: false,
    lastFind: 0,
  };

  // -------------------------------------------------------------------------
  // Frames and boxes
  // -------------------------------------------------------------------------

  /** Where a window's (0, 0) is in the top window's viewport, through same-origin frames. */
  function offsetOf(win) {
    let x = 0;
    let y = 0;
    let w = win;
    for (let i = 0; i < 8 && w && w !== window; i++) {
      let frame = null;
      try {
        frame = w.frameElement;
      } catch {
        return null;
      }
      if (!frame) return null;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
      w = frame.ownerDocument.defaultView;
    }
    return { x, y };
  }

  /** An element's box in the top window's viewport. */
  function topRect(el) {
    const r = el.getBoundingClientRect();
    const off = el.ownerDocument === document ? { x: 0, y: 0 } : offsetOf(el.ownerDocument.defaultView);
    if (!off) return { x: r.left, y: r.top, width: r.width, height: r.height };
    return { x: r.left + off.x, y: r.top + off.y, width: r.width, height: r.height };
  }

  const toPage = (box) => ({ x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height });
  const toView = (box) => ({ x: box.x - window.scrollX, y: box.y - window.scrollY, width: box.width, height: box.height });

  /** The smallest element at a point of the top viewport, into open shadow roots and same-origin frames. */
  function elementAt(x, y) {
    let doc = document;
    let ox = 0;
    let oy = 0;
    let el = doc.elementFromPoint(x, y);
    for (let depth = 0; el && depth < 12; depth++) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x - ox, y - oy);
        if (inner && inner !== el) {
          el = inner;
          continue;
        }
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let inner = null;
        try {
          inner = /** @type {HTMLIFrameElement} */ (el).contentDocument;
        } catch {
          inner = null;
        }
        if (!inner) break;
        const r = el.getBoundingClientRect();
        ox += r.left + el.clientLeft;
        oy += r.top + el.clientTop;
        guard(/** @type {HTMLIFrameElement} */ (el).contentWindow);
        doc = inner;
        const next = doc.elementFromPoint(x - ox, y - oy);
        if (!next || next === el) break;
        el = next;
        continue;
      }
      break;
    }
    // The root is the page itself, never a thing on it worth a mark.
    return el && el !== host && el !== el.ownerDocument.documentElement ? el : null;
  }

  /** Up a level, out of a shadow root or a frame when it is the top of one. */
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const rootNode = el.getRootNode();
    if (rootNode && rootNode.host) return rootNode.host;
    try {
      return el.ownerDocument.defaultView.frameElement || null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // What is read of an element
  // -------------------------------------------------------------------------

  const IMPLICIT = {
    a: (el) => (el.hasAttribute("href") ? "link" : ""),
    button: () => "button",
    nav: () => "navigation",
    main: () => "main",
    header: () => "banner",
    footer: () => "contentinfo",
    aside: () => "complementary",
    form: () => "form",
    img: () => "img",
    ul: () => "list",
    ol: () => "list",
    li: () => "listitem",
    table: () => "table",
    tr: () => "row",
    td: () => "cell",
    th: () => "columnheader",
    select: () => "combobox",
    textarea: () => "textbox",
    dialog: () => "dialog",
    h1: () => "heading",
    h2: () => "heading",
    h3: () => "heading",
    h4: () => "heading",
    h5: () => "heading",
    h6: () => "heading",
    input: (el) => {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider", search: "searchbox", image: "button" }[type] || (type === "hidden" ? "" : "textbox");
    },
  };

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const implicit = IMPLICIT[el.tagName.toLowerCase()];
    return implicit ? implicit(el) : "";
  }

  const flat = (text) => String(text || "").replace(/\s+/g, " ").trim();

  /** What an element shows, never what a field holds: a field's words are its value, which is never read. */
  function visibleText(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return "";
    let text = "";
    try {
      text = el.innerText ?? el.textContent ?? "";
    } catch {
      text = el.textContent ?? "";
    }
    return flat(text).slice(0, TEXT_MAX);
  }

  /** The accessible name, as well as the DOM alone says it; main asks the accessibility tree and prefers its answer. */
  function nameOf(el) {
    const label = el.getAttribute("aria-label");
    if (label) return flat(label);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const words = by
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter(Boolean)
        .map((n) => flat(n.textContent))
        .join(" ");
      if (words) return words.slice(0, TEXT_MAX);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img" || (tag === "input" && el.getAttribute("type") === "image")) return flat(el.getAttribute("alt"));
    if ((tag === "input" || tag === "select" || tag === "textarea") && el.id) {
      try {
        const forIt = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forIt) return flat(forIt.textContent).slice(0, TEXT_MAX);
      } catch {
        // An id no selector can hold.
      }
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return flat(el.getAttribute("value"));
      return flat(el.getAttribute("placeholder") || el.getAttribute("title"));
    }
    const role = roleOf(el);
    if (["button", "link", "heading", "tab", "menuitem", "option", "cell", "columnheader", "listitem", "checkbox", "radio"].includes(role)) return visibleText(el).slice(0, TEXT_MAX);
    return flat(el.getAttribute("title"));
  }

  const q = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  function countOf(doc, selector) {
    try {
      return doc.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  /** Every element a `role=x[name="y"]` selector could mean, by the same reading `roleOf` and `nameOf` do. */
  function byRole(doc, role, name) {
    const out = [];
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i];
      if (roleOf(el) === role && nameOf(el) === name) out.push(el);
    }
    return out;
  }

  /** Where an element is among its kind under its parent, as `:nth-of-type`. */
  function nthOf(el) {
    let n = 1;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === el.tagName) n++;
    return n;
  }

  /** A class path: up to two stable classes on the element, and its parent's when the element's alone are not enough. */
  function classSelector(el) {
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].filter((c) => !looksGenerated(c)).slice(0, 2);
    if (!classes.length) return "";
    const own = `${tag}${classes.map((c) => `.${CSS.escape(c)}`).join("")}`;
    if (countOf(el.ownerDocument, own) === 1 || !el.parentElement) return own;
    const parent = el.parentElement;
    const pclasses = [...parent.classList].filter((c) => !looksGenerated(c)).slice(0, 2);
    return pclasses.length ? `${parent.tagName.toLowerCase()}${pclasses.map((c) => `.${CSS.escape(c)}`).join("")} > ${own}` : own;
  }

  /** A position path, from the nearest stable id or from the root. */
  function pathSelector(el) {
    const parts = [];
    let at = el;
    for (let i = 0; at && at.nodeType === 1 && i < 24; i++) {
      if (at.id && !looksGenerated(at.id) && at !== el) {
        parts.unshift(`#${CSS.escape(at.id)}`);
        break;
      }
      const tag = at.tagName.toLowerCase();
      if (tag === "html") {
        parts.unshift("html");
        break;
      }
      const parent = at.parentElement;
      const needs = parent && [...parent.children].some((c) => c !== at && c.tagName === at.tagName);
      parts.unshift(needs ? `${tag}:nth-of-type(${nthOf(at)})` : tag);
      at = parent;
    }
    return parts.join(" > ");
  }

  function selectorsOf(el) {
    const doc = el.ownerDocument;
    const tag = el.tagName.toLowerCase();
    const out = [];
    const css = (kind, value) => value && out.push({ kind, value, unique: countOf(doc, value) === 1 });
    for (const attr of ["data-testid", "data-test", "data-test-id", "data-cy", "data-qa"]) {
      const v = el.getAttribute(attr);
      if (v) css("testid", `[${attr}=${q(v)}]`);
    }
    if (el.id && !looksGenerated(el.id)) css("id", `#${CSS.escape(el.id)}`);
    const role = roleOf(el);
    const name = nameOf(el);
    if (role && name && name.length <= 80) out.push({ kind: "role", value: `role=${role}[name=${q(name)}]`, unique: byRole(doc, role, name).length === 1 });
    for (const attr of ["name", "aria-label", "href", "alt", "placeholder", "title", "type"]) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 120) continue;
      if (attr === "type" && !["submit", "checkbox", "radio", "search", "email"].includes(v)) continue;
      css("attr", `${tag}[${attr}=${q(attr === "href" ? v.split(/[?#]/)[0] : v)}]`);
    }
    css("class", classSelector(el));
    css("path", pathSelector(el));
    return rankSelectors(out, 5);
  }

  /** A copy of the markup with no value of any field, no attribute off the list, and no more than `HTML_MAX`. */
  function markupOf(el) {
    let clone;
    try {
      clone = el.getElementsByTagName("*").length > 1500 ? el.cloneNode(false) : el.cloneNode(true);
    } catch {
      return "";
    }
    const scrub = (node) => {
      for (const attr of [...node.attributes]) if (!keepAttr(attr.name.toLowerCase())) node.removeAttribute(attr.name);
      const tag = node.tagName.toLowerCase();
      if (tag === "textarea") node.textContent = "";
      if (tag === "script" || tag === "style" || tag === "template") node.textContent = "";
    };
    scrub(clone);
    for (const node of clone.querySelectorAll("*")) scrub(node);
    const html = clone.outerHTML || "";
    return html.length > HTML_MAX ? `${html.slice(0, HTML_MAX - 1)}…` : html;
  }

  function stylesOf(el) {
    const out = {};
    try {
      const computed = el.ownerDocument.defaultView.getComputedStyle(el);
      for (const name of STYLES) out[name] = computed.getPropertyValue(name);
    } catch {
      // A detached element has no style worth keeping.
    }
    return out;
  }

  function attrsOf(el) {
    const out = {};
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (!keepAttr(name)) continue;
      out[name] = (name === "href" || name === "src" ? attr.value.split(/[?#]/)[0] : attr.value).slice(0, 300);
    }
    return out;
  }

  function frameOf(el) {
    if (el.ownerDocument === document) return "";
    try {
      return el.ownerDocument.location.href.split(/[?#]/)[0];
    } catch {
      return "";
    }
  }

  function read(el) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id && !looksGenerated(el.id) ? el.id : el.id || "",
      classes: [...el.classList].slice(0, 12),
      attrs: attrsOf(el),
      text: visibleText(el),
      role: roleOf(el),
      name: nameOf(el).slice(0, TEXT_MAX),
      selectors: selectorsOf(el),
      box: toPage(topRect(el)),
      styles: stylesOf(el),
      html: markupOf(el),
      frame: frameOf(el),
    };
  }

  /** The elements a box of the viewport holds whole, outermost first and largest first, up to a few. */
  function elementsIn(box) {
    const inside = [];
    const all = document.body ? document.body.querySelectorAll("*") : [];
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.left >= box.x - 1 && r.top >= box.y - 1 && r.right <= box.x + box.width + 1 && r.bottom <= box.y + box.height + 1) inside.push({ el, area: r.width * r.height });
    }
    const outer = inside.filter(({ el }) => !inside.some((o) => o.el !== el && o.el.contains(el)));
    outer.sort((a, b) => b.area - a.area);
    return outer.slice(0, ELEMENTS_MAX).map((o) => o.el);
  }

  /** The nearest heading above a box, to say where an area is. */
  function headingAbove(box) {
    let best = null;
    let bestBottom = -Infinity;
    for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading],legend")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.bottom > box.y + 4 || r.right < box.x - 200 || r.left > box.x + box.width + 200) continue;
      if (r.bottom > bestBottom) {
        bestBottom = r.bottom;
        best = el;
      }
    }
    return best ? flat(best.textContent).slice(0, 120) : "";
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  const newKey = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /** A frame and another, so a hover box hidden before a picture is not in it. */
  const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));

  /**
   * A mark made: the pin is drawn at once (unnumbered until main numbers it),
   * the facts are read now — at the pick, not on hover — and sent to main
   * once the hover box is off the screen, since main takes the crop next.
   */
  function pick(kind, els, extra) {
    const k = newKey();
    const first = els[0] || null;
    const viewBox = extra.box || (first ? topRect(first) : { x: state.pointer.x, y: state.pointer.y, width: 1, height: 1 });
    const pageBox = toPage(viewBox);
    const anchor = extra.anchor || (first ? topRect(first) : viewBox);
    const at = extra.at || { x: viewBox.x + viewBox.width, y: viewBox.y };
    const { fx, fy } = pinFraction(anchor, at.x, at.y);
    const elements = els.map(read);
    const pin = {
      k,
      n: 0,
      kind,
      els: els.slice(),
      selectors: elements.map((e) => e.selectors),
      fx,
      fy,
      // Regions and drawings are anchored to the page, an element's pin to its element.
      pageBox: kind === "region" || kind === "pen" || !first ? pageBox : null,
      stroke: extra.stroke || null,
      shape: extra.shape || "",
      url: location.href,
      lost: false,
      node: null,
    };
    state.pins.set(k, pin);
    state.pending = [];
    hideHover();
    mount();
    loop();
    void twoFrames().then(() =>
      send({
        t: "pick",
        k,
        kind,
        elements,
        box: pageBox,
        view: viewBox,
        pin: { fx, fy },
        text: extra.text || "",
        near: extra.near || "",
        shape: extra.shape || "",
        stroke: extra.stroke || null,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        url: location.href,
      }),
    );
  }

  function pickElement(el, shift) {
    if (!el) return;
    if (shift) {
      const at = state.pending.indexOf(el);
      if (at >= 0) state.pending.splice(at, 1);
      else if (state.pending.length < ELEMENTS_MAX) state.pending.push(el);
      draw();
      return;
    }
    const els = state.pending.includes(el) ? state.pending.slice() : [...state.pending, el].slice(0, ELEMENTS_MAX);
    pick("element", els, { at: { x: state.pointer.x, y: state.pointer.y }, anchor: topRect(els[0]) });
  }

  function finishRegion(drag) {
    const box = boxOfPoints(drag.points.map((p) => ({ x: p.x - window.scrollX, y: p.y - window.scrollY })));
    if (box.width < 6 && box.height < 6) {
      pickElement(elementAt(box.x, box.y), false);
      return;
    }
    const els = elementsIn(box);
    pick("region", els, { box, at: { x: box.x + box.width, y: box.y }, anchor: box, near: headingAbove(box) });
  }

  function finishPen(drag) {
    const view = drag.points.map((p) => ({ x: p.x - window.scrollX, y: p.y - window.scrollY }));
    const box = boxOfPoints(view);
    if (box.width < 4 && box.height < 4) {
      pickElement(elementAt(box.x, box.y), false);
      return;
    }
    let els = elementsIn(box);
    if (!els.length) {
      const middle = elementAt(box.x + box.width / 2, box.y + box.height / 2);
      if (middle && middle !== document.body && middle !== document.documentElement) els = [middle];
    }
    // A stroke of many points is kept to a few hundred, page coordinates, for the pin layer to draw.
    const step = Math.max(1, Math.ceil(drag.points.length / 300));
    const stroke = drag.points.filter((_, i) => i % step === 0 || i === drag.points.length - 1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: p.w }));
    pick("pen", els, { box, at: { x: box.x + box.width, y: box.y }, anchor: box, stroke, shape: drag.shape, near: els.length ? "" : headingAbove(box) });
  }

  function boxOfPoints(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  /** The selection, made with marking off, as a text mark. False when nothing is selected. */
  function selectionMark() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const text = sel.toString().slice(0, SELECTION_MAX);
    if (!text.trim()) return false;
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const all = range.getBoundingClientRect();
    const box = { x: all.left, y: all.top, width: all.width, height: all.height };
    const last = rects[rects.length - 1] || all;
    let container = range.commonAncestorContainer;
    if (container.nodeType !== 1) container = /** @type {Node} */ (container.parentElement || document.body);
    const els = container && container !== document.body && container !== document.documentElement ? [container] : [];
    pick("text", els, { box, at: { x: last.right, y: last.top }, anchor: els[0] ? topRect(els[0]) : box, text });
    sel.removeAllRanges();
    return true;
  }

  // -------------------------------------------------------------------------
  // Finding a pin's element again
  // -------------------------------------------------------------------------

  function resolve(selector) {
    const role = /^role=([\w-]+)\[name="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
    if (role) {
      const found = byRole(document, role[1] || "", (role[2] || "").replace(/\\(.)/g, "$1"));
      return found.length === 1 ? found[0] : null;
    }
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 ? found[0] : null;
    } catch {
      return null;
    }
  }

  /** A pin whose element was replaced (a re-render) is found again by its selectors, best first. */
  function refind(pin) {
    const lists = pin.selectors || [];
    const found = [];
    for (const list of lists) {
      let el = null;
      for (const s of list || []) {
        el = resolve(s.value);
        if (el) break;
      }
      if (el) found.push(el);
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function hideHover() {
    if (hoverBox) hoverBox.style.display = "none";
  }

  function showHover(el) {
    if (!hoverBox || !el) return hideHover();
    const r = topRect(el);
    Object.assign(hoverBox.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    const cls = [...el.classList].filter((c) => !looksGenerated(c)).slice(0, 2).map((c) => `.${c}`).join("");
    hoverTag.textContent = `${el.tagName.toLowerCase()}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    hoverTag.classList.toggle("under", r.y < 26);
  }

  function pinPlace(pin) {
    if (pin.pageBox) return pinPoint(toView(pin.pageBox), pin.fx, pin.fy);
    const el = pin.els.find((e) => e.isConnected);
    if (!el) return null;
    const box = topRect(el);
    // Not drawn: a closed menu's item, `display: none`. Its pin comes back when it does.
    if (box.width === 0 && box.height === 0) return null;
    return pinPoint(box, pin.fx, pin.fy);
  }

  function drawStroke(points, shape) {
    const view = points.map((p) => ({ x: p.x - window.scrollX, y: p.y - window.scrollY, w: p.w }));
    if (view.length < 2) return;
    ctx.strokeStyle = "#ff4fa3";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const a = view[0];
    const b = view[view.length - 1];
    if (shape === "arrow") {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      for (const side of [-1, 1]) {
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 14 * Math.cos(angle + side * 0.45), b.y - 14 * Math.sin(angle + side * 0.45));
      }
      ctx.stroke();
      return;
    }
    if (shape === "ellipse") {
      const box = boxOfPoints([a, b]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, Math.max(1, box.width / 2), Math.max(1, box.height / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    for (let i = 1; i < view.length; i++) {
      ctx.lineWidth = 1.5 + 3 * (view[i].w ?? 0.5);
      ctx.beginPath();
      ctx.moveTo(view[i - 1].x, view[i - 1].y);
      ctx.lineTo(view[i].x, view[i].y);
      ctx.stroke();
    }
  }

  function draw() {
    if (!shown()) {
      unmount();
      return;
    }
    mount();
    // The canvas is the viewport at the screen's density.
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // Regions and the shift-click boxes are drawn afresh; a pin keeps its
    // node, so one under the pointer is not a new element every frame.
    for (const old of layer.querySelectorAll(".region, .pending")) old.remove();
    const drawn = new Set();

    const now = performance.now();
    const looking = now - state.lastFind > 400;
    if (looking) state.lastFind = now;
    for (const pin of state.pins.values()) {
      if (pin.url !== location.href && pin.url.split("#")[0] !== location.href.split("#")[0]) continue;
      if (!pin.pageBox && !pin.els.some((e) => e.isConnected) && looking) {
        const found = refind(pin);
        if (found.length) pin.els = found;
      }
      const lost = !pin.pageBox && !pin.els.some((e) => e.isConnected);
      if (lost !== pin.lost) {
        pin.lost = lost;
        send({ t: "lost", k: pin.k, lost });
      }
      if (pin.kind === "region" && pin.pageBox) {
        const r = toView(pin.pageBox);
        const region = document.createElement("div");
        region.className = "region";
        Object.assign(region.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
        layer.append(region);
      }
      if (pin.kind === "pen" && pin.stroke) drawStroke(pin.stroke, pin.shape);
      const at = pinPlace(pin);
      if (!at || at.x < -PIN || at.y < -PIN || at.x > window.innerWidth + PIN || at.y > window.innerHeight + PIN) continue;
      if (!pin.node) {
        pin.node = document.createElement("div");
        pin.node.className = "pin";
      }
      if (!pin.node.isConnected) layer.append(pin.node);
      pin.node.classList.toggle("lost", pin.lost);
      const label = pin.n ? String(pin.n) : "•";
      if (pin.node.textContent !== label) pin.node.textContent = label;
      pin.node.style.left = `${at.x + PIN / 2}px`;
      pin.node.style.top = `${at.y - PIN / 2}px`;
      drawn.add(pin.node);
    }
    for (const old of layer.querySelectorAll(".pin")) if (!drawn.has(old)) old.remove();
    for (const el of state.pending) {
      if (!el.isConnected) continue;
      const r = topRect(el);
      const box = document.createElement("div");
      box.className = "pending";
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      layer.append(box);
    }
    if (state.drag) drawDrag(state.drag);
    if (state.mode && !state.drag && state.hovered && state.hovered.isConnected) showHover(state.hovered);
    else hideHover();
  }

  function drawDrag(drag) {
    if (drag.tool === "pen") {
      drawStroke(drag.points, drag.shape);
      return;
    }
    const view = drag.points.map((p) => ({ x: p.x - window.scrollX, y: p.y - window.scrollY }));
    const r = boxOfPoints([view[0], view[view.length - 1]]);
    const region = document.createElement("div");
    region.className = "region";
    Object.assign(region.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    layer.append(region);
  }

  /** Every frame while anything is drawn: pins follow scrolling, resizing and re-layout because they are drawn again where their element is now. */
  function loop() {
    if (state.looping) return;
    state.looping = true;
    const tick = () => {
      if (!shown()) {
        state.looping = false;
        unmount();
        return;
      }
      draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------
  // The pointer, while marking
  // -------------------------------------------------------------------------

  const guarded = new WeakSet();

  /**
   * The clicks a window would have seen, taken first. A capture listener on
   * `window` runs before any listener on the page's elements, React's root
   * included, so a pick never presses what it marks; `pointermove`,
   * `mouseover` and the wheel are not on the list, which is what keeps hover
   * menus open and long pages scrolling under the pointer.
   */
  const BLOCKED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart"];

  function guard(win) {
    if (!win || guarded.has(win)) return;
    guarded.add(win);
    const offset = () => (win === window ? { x: 0, y: 0 } : offsetOf(win));
    for (const type of BLOCKED) {
      win.addEventListener(
        type,
        (event) => {
          if (!state.mode) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const off = offset();
          if (!off) return;
          const x = event.clientX + off.x;
          const y = event.clientY + off.y;
          if (type === "pointerdown" && event.button === 0) down(x, y, event);
          else if (type === "pointerup" && event.button === 0) up(x, y, event);
        },
        true,
      );
    }
    win.addEventListener(
      "pointermove",
      (event) => {
        if (!state.mode) return;
        const off = offset();
        if (!off) return;
        move(event.clientX + off.x, event.clientY + off.y, event);
      },
      { capture: true, passive: true },
    );
    win.addEventListener(
      "scroll",
      () => {
        if (state.mode && !state.drag && state.pointer.x >= 0) hover(state.pointer.x, state.pointer.y);
      },
      { capture: true, passive: true },
    );
  }

  function hover(x, y) {
    const el = elementAt(x, y);
    if (el !== state.hovered) {
      state.hovered = el;
      state.below = [];
    }
  }

  function move(x, y, event) {
    state.pointer = { x, y };
    if (state.drag) {
      const w = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
      const p = { x: x + window.scrollX, y: y + window.scrollY, w };
      if (state.drag.tool === "pen" && state.drag.shape === "free") state.drag.points.push(p);
      else state.drag.points[1] = p;
      return;
    }
    hover(x, y);
  }

  function down(x, y, event) {
    state.pointer = { x, y };
    if (state.tool === "element") return;
    const w = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
    const p = { x: x + window.scrollX, y: y + window.scrollY, w };
    state.drag = { tool: state.tool, shape: state.shape, points: [p, p] };
  }

  function up(x, y, event) {
    state.pointer = { x, y };
    const drag = state.drag;
    state.drag = null;
    if (drag) {
      if (drag.tool === "region") finishRegion(drag);
      else finishPen(drag);
      return;
    }
    hover(x, y);
    pickElement(state.hovered, event.shiftKey);
  }

  // -------------------------------------------------------------------------
  // Main's way in
  // -------------------------------------------------------------------------

  // The page's own top-layer elements, opened after ours, would draw above it.
  document.addEventListener(
    "toggle",
    (event) => {
      if (event.target !== host && event.newState === "open" && shown()) requestAnimationFrame(promote);
    },
    true,
  );
  new MutationObserver((records) => {
    if (!shown()) return;
    for (const record of records) {
      if (record.type === "childList" && host && !host.isConnected) mount();
      if (record.type === "attributes" && record.target !== host && record.target instanceof Element && record.target.hasAttribute("open")) requestAnimationFrame(promote);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });

  guard(window);

  G.__kururuMarks = {
    /** Marking on or off, and with which tool. Off leaves the pins, passive, for as long as there are marks. */
    setMode(on, tool, shape) {
      state.mode = on === true;
      if (tool === "element" || tool === "region" || tool === "pen") state.tool = tool;
      if (shape === "free" || shape === "arrow" || shape === "ellipse") state.shape = shape;
      if (!state.mode) {
        state.drag = null;
        state.pending = [];
        hideHover();
      }
      if (shown()) {
        mount();
        loop();
      } else unmount();
      return true;
    },
    /**
     * The marks main holds, as pins: numbers for the ones this page made,
     * and the ones made before a navigation found again by their selectors.
     * A pin main no longer has is taken off.
     */
    setPins(list) {
      const keep = new Set();
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || typeof p.k !== "string") continue;
        keep.add(p.k);
        const had = state.pins.get(p.k);
        if (had) {
          had.n = p.n;
          continue;
        }
        /** @type {any} */
        const pin = {
          k: p.k,
          n: p.n,
          kind: p.kind,
          els: [],
          selectors: p.selectors || [],
          fx: p.fx,
          fy: p.fy,
          pageBox: p.pageBox || null,
          stroke: p.stroke || null,
          shape: p.shape || "",
          url: p.url || "",
          lost: false,
          node: null,
        };
        if (!pin.pageBox) pin.els = refind(pin);
        state.pins.set(p.k, pin);
      }
      for (const k of [...state.pins.keys()]) if (!keep.has(k)) state.pins.delete(k);
      if (shown()) {
        mount();
        loop();
      } else unmount();
      return true;
    },
    /** ↑ and ↓: to the hovered element's parent, and back down the way it came. */
    walk(dir) {
      const el = state.hovered;
      if (!el) return false;
      if (dir === "up") {
        const parent = parentOf(el);
        if (!parent || parent === document.documentElement) return false;
        state.below.push(el);
        state.hovered = parent;
      } else {
        const back = state.below.pop();
        if (back && parent0(back) === el) state.hovered = back;
        else if (el.firstElementChild) state.hovered = el.firstElementChild;
      }
      return true;
    },
    /** Esc: a drag or a shift-click gathering is dropped first; with neither, marking is to end. */
    escape() {
      if (state.drag) {
        state.drag = null;
        return "kept";
      }
      if (state.pending.length) {
        state.pending = [];
        return "kept";
      }
      return "exit";
    },
    selectionMark,
    /** The hovered element and its ancestors, for main to hold their hover state. */
    hoverChain() {
      const chain = [];
      for (let el = state.hovered; el && chain.length < 24; el = parentOf(el)) chain.push(el);
      return chain;
    },
    /** One of a mark's elements, for main to ask the accessibility tree about. */
    node(k, i) {
      const pin = state.pins.get(k);
      return pin ? pin.els[i] || null : null;
    },
    /** Two frames, for main to wait on before a picture. */
    frame: twoFrames,
  };

  function parent0(el) {
    return parentOf(el);
  }

  send({ t: "ready", url: location.href });
}

/** The source main evaluates in the isolated world: the pure pieces, then the script, run once. */
const MARK_SOURCE = `(() => {\n${[pinPoint, pinFraction, rankSelectors, looksGenerated].map(String).join("\n")}\n(${markingMain})(${JSON.stringify(BINDING)});\n})();`;

module.exports = { WORLD, BINDING, MARK_SOURCE, pinPoint, pinFraction, rankSelectors, looksGenerated };
