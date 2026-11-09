/**
 * Environment checks for replaying learned strategies, after muscle-mem's Check idea: while
 * the model solves a task, code records what the environment looked like around each step;
 * before and after replaying that step, the current environment must look the same, or the
 * strategy is not replayed blindly. Everything here is recorded by code, never by the model.
 */

/** Recorded environment around one step. `undefined` = not checked, `null` = no window open. */
export interface StepCheck {
  /** Title of the window that must be open before this step (menu clicks). */
  preWindow?: string | null;
  /** Title of the window that must be open after this step (commands/NPCs/clicks that open menus). */
  postWindow?: string | null;
}

/** Steps whose meaning depends on which window is open when they run. */
export const PRE_WINDOW_TOOLS = new Set(["click_slot", "close_window"]);
/** Steps that open, change or close a window. */
export const POST_WINDOW_TOOLS = new Set(["run_command", "interact_entity", "use_held_item", "click_slot"]);

/**
 * Window titles are compared loosely: formatting codes, digits and spaces are ignored,
 * because titles often contain balances or page numbers ("商店 第2页 余额:150").
 */
export function normalizeTitle(title: string | null): string | null {
  if (title === null) return null;
  return title
    .replace(/[§&][0-9a-fk-orx]/gi, "")
    .replace(/[\d\s.,:：]+/g, "")
    .toLowerCase();
}

export function sameWindow(expected: string | null, actual: string | null): boolean {
  return normalizeTitle(expected) === normalizeTitle(actual);
}

export function describeWindowTitle(title: string | null): string {
  return title === null ? "没有打开窗口" : `「${title}」`;
}

/** Item IDs whose count went up between two inventory snapshots. */
export function gainedItems(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.entries()].filter(([name, n]) => n > (before.get(name) ?? 0)).map(([name]) => name);
}
