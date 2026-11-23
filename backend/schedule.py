"""Task schedule rules for the date-based Timeline (no database, no Flask).

The Timeline places a task on the days from planned_start to planned_end
(inclusive, "YYYY-MM-DD", local dates). These pure functions check a proposed
change against the board before anything is saved; app.py will call them once
the schedule columns exist. Nothing here moves other tasks: problems are
reported and the user decides how to fix them.

Rules
- Dates: both set ("scheduled") or both empty ("unscheduled"); end >= start.
- A task must start strictly after each prerequisite's planned end. Dates have
  no time of day, so finishing and starting on the same day is not allowed.
- Completed tasks are finished work: a completed prerequisite no longer
  constrains its dependents, and a completed task is not checked against its
  prerequisites.
- These are blocking conflicts (errors). They apply to every kind of change:
  the task's own dates, its prerequisite list, and a prerequisite's dates
  moving later (the dependents it would break are listed).
- Warnings only (saving is allowed): a prerequisite is not scheduled yet, and
  one member has open tasks on overlapping days.
- Clearing a task's dates is always allowed; dependents get a warning.

A task is a dict with: id, title, status ("todo" | "done"), assignee_id,
planned_start, planned_end, prerequisites (list of task ids). Extra keys are
ignored. `tasks` maps task id -> task.
"""
import re
from datetime import date, timedelta

DATE_FORMAT = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KEEP = object()  # "this field is not part of the change"

ERROR, WARNING = "error", "warning"


class ScheduleError(ValueError):
    """Input that is not a valid schedule at all (bad format, end before start)."""


def parse_date(value, field="date"):
    """'YYYY-MM-DD' -> date. None or '' -> None."""
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        raise ScheduleError(f"{field} must be a date in YYYY-MM-DD format.")
    text = value.strip()
    # fromisoformat alone also accepts forms like 20261123 or 2026-W48-1.
    if not DATE_FORMAT.match(text):
        raise ScheduleError(f"{field} must be a date in YYYY-MM-DD format, got “{value}”.")
    try:
        return date.fromisoformat(text)
    except ValueError:  # e.g. 2026-02-30
        raise ScheduleError(f"{field} is not a real date: “{value}”.") from None


def parse_range(start, end):
    """(start, end) as dates, both None for unscheduled. Raises ScheduleError."""
    s = parse_date(start, "Planned start")
    e = parse_date(end, "Planned end")
    if (s is None) != (e is None):
        raise ScheduleError("Set both the planned start and end dates, or clear both.")
    if s is not None and e < s:
        raise ScheduleError("The planned end date can't be before the planned start date.")
    return s, e


def _issue(severity, code, message, task_id, related=()):
    return {"severity": severity, "code": code, "message": message,
            "taskId": task_id, "relatedIds": list(related)}


def _title(task):
    return f"“{task.get('title') or task['id']}”"


def _range(task):
    """Parsed (start, end) of a stored task; (None, None) if unscheduled or invalid."""
    try:
        return parse_range(task.get("planned_start"), task.get("planned_end"))
    except ScheduleError:
        return None, None


def _open(task):
    return task.get("status") != "done"


def dependents_of(tasks, task_id):
    return [t for t in tasks.values() if task_id in (t.get("prerequisites") or [])]


def prerequisite_issues(tasks, task):
    """Conflicts/warnings between `task` and its own prerequisites."""
    issues = []
    start, _ = _range(task)
    if start is None or not _open(task):
        return issues
    for pid in task.get("prerequisites") or []:
        pre = tasks.get(pid)
        if pre is None or not _open(pre):
            continue
        _, pre_end = _range(pre)
        if pre_end is None:
            issues.append(_issue(
                WARNING, "prerequisite_unscheduled",
                f"Prerequisite {_title(pre)} has no planned dates yet.", task["id"], [pid]))
        elif start <= pre_end:
            issues.append(_issue(
                ERROR, "starts_before_prerequisite_ends",
                f"{_title(task)} starts on {start.isoformat()}, but its prerequisite {_title(pre)} "
                f"is planned to end on {pre_end.isoformat()}. Start it on "
                f"{(pre_end + timedelta(days=1)).isoformat()} or later.",
                task["id"], [pid]))
    return issues


def dependent_issues(tasks, task):
    """Conflicts/warnings between `task` and the open, scheduled tasks that depend on it."""
    issues = []
    if not _open(task):
        return issues
    _, end = _range(task)
    for dep in dependents_of(tasks, task["id"]):
        dep_start, _ = _range(dep)
        if dep_start is None or not _open(dep):
            continue
        if end is None:
            issues.append(_issue(
                WARNING, "prerequisite_unscheduled",
                f"{_title(dep)} depends on {_title(task)}, which has no planned dates.", dep["id"], [task["id"]]))
        elif dep_start <= end:
            issues.append(_issue(
                ERROR, "ends_after_dependent_starts",
                f"{_title(task)} would end on {end.isoformat()}, but {_title(dep)} depends on it and "
                f"starts on {dep_start.isoformat()}. Move {_title(dep)} later first, or end this task earlier.",
                dep["id"], [task["id"]]))
    return issues


def overlap_issues(tasks, task):
    """Warnings for open tasks of the same member on overlapping days."""
    start, end = _range(task)
    member = task.get("assignee_id")
    if start is None or member is None or not _open(task):
        return []
    issues = []
    for other in tasks.values():
        if other["id"] == task["id"] or other.get("assignee_id") != member or not _open(other):
            continue
        o_start, o_end = _range(other)
        if o_start is not None and start <= o_end and o_start <= end:
            issues.append(_issue(
                WARNING, "member_overlap",
                f"{_title(task)} overlaps {_title(other)} for the same member "
                f"({max(start, o_start).isoformat()} to {min(end, o_end).isoformat()}).",
                task["id"], [other["id"]]))
    return issues


def apply_change(tasks, task_id, planned_start=KEEP, planned_end=KEEP, prerequisites=KEEP, assignee_id=KEEP):
    """A copy of `tasks` with one task changed. Raises ScheduleError on bad input."""
    if task_id not in tasks:
        raise ScheduleError(f"Unknown task “{task_id}”.")
    task = dict(tasks[task_id])
    start = task.get("planned_start") if planned_start is KEEP else planned_start
    end = task.get("planned_end") if planned_end is KEEP else planned_end
    s, e = parse_range(start, end)
    task["planned_start"] = s.isoformat() if s else None
    task["planned_end"] = e.isoformat() if e else None
    if prerequisites is not KEEP:
        prereqs = list(dict.fromkeys(prerequisites or []))
        unknown = [p for p in prereqs if p not in tasks]
        if unknown:
            raise ScheduleError(f"Unknown prerequisite(s): {', '.join(unknown)}.")
        if task_id in prereqs:
            raise ScheduleError("A task can't be its own prerequisite.")
        task["prerequisites"] = prereqs
    if assignee_id is not KEEP:
        task["assignee_id"] = assignee_id
    changed = dict(tasks)
    changed[task_id] = task
    return changed


def check_change(tasks, task_id, planned_start=KEEP, planned_end=KEEP, prerequisites=KEEP, assignee_id=KEEP):
    """Check one proposed change: new dates (drag, date edit, clearing dates),
    a new prerequisite list, a new assignee, or any combination.

    Returns {"ok": bool, "errors": [...], "warnings": [...]}; ok is False when
    there is any error and the change must not be saved. Raises ScheduleError
    for invalid input. Cycles are checked by the existing dependency code.
    """
    changed = apply_change(tasks, task_id, planned_start, planned_end, prerequisites, assignee_id)
    task = changed[task_id]
    issues = prerequisite_issues(changed, task) + dependent_issues(changed, task) + overlap_issues(changed, task)
    errors = [i for i in issues if i["severity"] == ERROR]
    warnings = [i for i in issues if i["severity"] == WARNING]
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def board_issues(tasks):
    """Every current problem on the board, by task id (for showing on cards).

    Conflicts can exist in stored data even though changes are checked, e.g.
    after a completed prerequisite is reopened. Each issue is listed once, on
    the task whose dates need attention (the dependent for date conflicts).
    """
    by_task = {tid: [] for tid in tasks}
    for task in tasks.values():
        for issue in prerequisite_issues(tasks, task) + overlap_issues(tasks, task):
            by_task[issue["taskId"]].append(issue)
    return by_task
