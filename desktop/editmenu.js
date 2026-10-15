/**
 * The right-click menu every Mac text field has, which an Electron window does
 * not have until somebody builds it.
 *
 * Chromium hands a right-click to the embedder and Electron's answer is to do
 * nothing, so a card's description or the search box answered a right-click
 * with silence while every other application on the machine offers Cut, Copy
 * and Paste. It is built in the main process, once, for the whole window,
 * rather than as a React menu per field: the roles are the system's own
 * items — the same labels, the same undo stack the keyboard uses — and a menu
 * drawn in the page would be a second, slightly wrong copy of something macOS
 * already draws.
 *
 * It stays out of the way of kururu's own menus by never being asked. The
 * tabs, sidebar rows, the file tree and the needs list all `preventDefault`
 * their `contextmenu`, and Chromium does not tell the embedder about a right-click
 * the page has claimed. A terminal is the one place a right-click falls through
 * unclaimed and must still show nothing, and the preload claims it there.
 *
 * Like `menu.js`, this half is data and knows nothing about Electron, so what
 * the menu offers for a given right-click can be read in a test. `main.js`
 * attaches the clicks by id.
 */

/** As many guesses as the system's own menu shows before it would scroll a reader's eye. */
const GUESSES = 5;

/**
 * The menu for one right-click, from the `params` of `webContents`'
 * `context-menu` event, or null when there is nothing to offer — a right-click
 * on a button or a bare panel, which should go on looking like nothing
 * happened rather than open an empty menu.
 */
function editMenuTemplate(params) {
  const flags = params.editFlags ?? {};
  const selected = typeof params.selectionText === "string" && params.selectionText.trim() !== "";
  const items = [];

  // The spelling half comes first, as it does in TextEdit, because when it is
  // there it is the reason for the right-click. Chromium only reports a
  // misspelling inside a field that checks spelling, so a terminal's input or
  // a field marked `spellcheck={false}` never grows one.
  //
  // On macOS the guesses usually do not come: Chromium flags the word through
  // the system's checker but fetches the guesses for its own menu, which
  // Electron does not use, so `dictionarySuggestions` arrives empty. There is
  // no "No Guesses Found" for that, because it would be a lie about the word —
  // only Learn Spelling, which works, and the guesses whenever they are sent.
  if (params.isEditable && params.misspelledWord) {
    const guesses = (params.dictionarySuggestions ?? []).slice(0, GUESSES);
    for (const guess of guesses) items.push({ id: "replace", label: guess, word: guess });
    if (guesses.length) items.push({ type: "separator" });
    items.push({ id: "learn", label: "Learn Spelling", word: params.misspelledWord });
    items.push({ type: "separator" });
  }

  if (params.isEditable) {
    items.push(
      { role: "undo", enabled: flags.canUndo !== false },
      { role: "redo", enabled: flags.canRedo !== false },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut !== false },
      { role: "copy", enabled: flags.canCopy !== false },
      { role: "paste", enabled: flags.canPaste !== false },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll !== false },
    );
    return items;
  }

  // Read-only text: an agent's reply in the Kuru drawer, a card's body on the
  // board, a line in Settings. Copy is the only thing that can be done to it.
  if (selected) return [{ role: "copy" }];

  return null;
}

module.exports = { editMenuTemplate };
