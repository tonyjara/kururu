/**
 * What a right-click offers. The menu is the system's, but which items it
 * has for which right-click is kururu's decision, and the wrong one is either
 * an empty menu over a button or no Paste in a field.
 */
import { describe, expect, it } from "bun:test";
import { editMenuTemplate } from "../editmenu.js";

const allowed = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const roles = (template) => template.filter((item) => item.role).map((item) => item.role);

describe("editMenuTemplate", () => {
  it("offers the edit items in a field", () => {
    const template = editMenuTemplate({ isEditable: true, selectionText: "", editFlags: allowed });
    expect(roles(template)).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
  });

  it("greys out what the field says cannot be done", () => {
    const template = editMenuTemplate({ isEditable: true, selectionText: "", editFlags: { ...allowed, canCut: false, canCopy: false } });
    const byRole = Object.fromEntries(template.filter((item) => item.role).map((item) => [item.role, item.enabled]));
    expect(byRole).toMatchObject({ cut: false, copy: false, paste: true });
  });

  it("offers only Copy on selected read-only text", () => {
    expect(editMenuTemplate({ isEditable: false, selectionText: "a reply", editFlags: allowed })).toEqual([{ role: "copy" }]);
  });

  it("offers nothing with no field and no selection", () => {
    expect(editMenuTemplate({ isEditable: false, selectionText: "  ", editFlags: allowed })).toBeNull();
  });

  it("puts the guesses first on a misspelling, then the edit items", () => {
    const template = editMenuTemplate({
      isEditable: true,
      selectionText: "teh",
      misspelledWord: "teh",
      dictionarySuggestions: ["the", "ten", "tea", "tech", "eh", "Te"],
      editFlags: allowed,
    });
    const guesses = template.filter((item) => item.id === "replace").map((item) => item.word);
    expect(guesses).toEqual(["the", "ten", "tea", "tech", "eh"]);
    expect(template[0]).toMatchObject({ id: "replace", word: "the" });
    expect(template.find((item) => item.id === "learn")).toMatchObject({ word: "teh" });
    expect(roles(template)).toContain("paste");
  });

  it("offers Learn Spelling alone when no guesses are sent, as on macOS", () => {
    const template = editMenuTemplate({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: [], editFlags: allowed });
    expect(template[0]).toMatchObject({ id: "learn", word: "teh" });
    expect(template[1]).toEqual({ type: "separator" });
    expect(template.some((item) => item.id === "replace")).toBe(false);
  });
});
