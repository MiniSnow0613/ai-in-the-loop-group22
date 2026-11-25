/*
 * How schedule issues from the backend (task.scheduleIssues, see
 * backend/schedule.py) are presented. The data is unchanged; only the display
 * differs:
 *   error                   -> "Conflict": red, the change would break a dependency
 *   warning (dependency)    -> "Warning": amber, e.g. a prerequisite has no dates
 *   warning member_overlap  -> not shown. Overlapping tasks for one member are
 *                              allowed (planned dates are not continuous work)
 *                              and already appear side by side on the Timeline.
 *                              The backend still reports them, e.g. for a later
 *                              workload view.
 */

export const isOverlapNote = (issue) => issue.code === "member_overlap";

/** "error" | "warning" | "note" for one issue. */
export function issueKind(issue) {
  if (issue.severity === "error") return "error";
  return isOverlapNote(issue) ? "note" : "warning";
}

export const ISSUE_LABEL = { error: "Conflict", warning: "Warning" };

/** The issues people need to see: conflicts and dependency warnings. */
export const shownIssues = (issues = []) => issues.filter((i) => !isOverlapNote(i));

/** The most important styling for a card: "error", "warning" or null. */
export function cardIssueLevel(issues = []) {
  if (issues.some((i) => issueKind(i) === "error")) return "error";
  if (issues.some((i) => issueKind(i) === "warning")) return "warning";
  return null;
}
