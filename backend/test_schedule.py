"""schedule.py: pure date rules for the date-based Timeline (no database)."""
import copy
from datetime import date

import pytest

import schedule
from schedule import ScheduleError, board_issues, check_change, parse_date, parse_range


def task(tid, title, start=None, end=None, prereqs=(), member=None, status="todo"):
    return {"id": tid, "title": title, "status": status, "assignee_id": member,
            "planned_start": start, "planned_end": end, "prerequisites": list(prereqs)}


@pytest.fixture
def board():
    """data -> train -> eval chain; report overlaps data for Member A."""
    tasks = [
        task("data", "Update dataset", "2026-11-23", "2026-11-24", member="member-a"),
        task("train", "Train model", "2026-11-25", "2026-11-27", ["data"], member="member-b"),
        task("eval", "Evaluate model", None, None, ["train"]),
        task("report", "Write report", "2026-11-24", "2026-11-25", member="member-a"),
        task("idea", "Unscheduled idea"),
    ]
    return {t["id"]: t for t in tasks}


def codes(issues):
    return sorted(i["code"] for i in issues)


# ---------- date input ----------

def test_parse_date_accepts_iso_and_empty():
    assert parse_date("2026-11-23") == date(2026, 11, 23)
    assert parse_date(" 2026-11-23 ") == date(2026, 11, 23)
    assert parse_date(None) is None and parse_date("") is None


@pytest.mark.parametrize("bad", ["2026/11/23", "20261123", "2026-W48-1", "23-11-2026", "2026-02-30", "soon", 20261123])
def test_parse_date_rejects_other_formats(bad):
    with pytest.raises(ScheduleError):
        parse_date(bad)


def test_parse_range_rules():
    assert parse_range("2026-11-23", "2026-11-23") == (date(2026, 11, 23), date(2026, 11, 23))  # one day
    assert parse_range(None, None) == (None, None)
    with pytest.raises(ScheduleError, match="both"):
        parse_range("2026-11-23", None)
    with pytest.raises(ScheduleError, match="before the planned start"):
        parse_range("2026-11-24", "2026-11-23")


# ---------- the task's own dates (drag-and-drop or date edit) ----------

def test_start_must_be_after_prerequisite_end_not_same_day(board):
    same_day = check_change(board, "train", planned_start="2026-11-24", planned_end="2026-11-26")
    assert not same_day["ok"]
    [err] = same_day["errors"]
    assert err["code"] == "starts_before_prerequisite_ends"
    assert err["taskId"] == "train" and err["relatedIds"] == ["data"]
    assert "2026-11-25 or later" in err["message"]

    next_day = check_change(board, "train", planned_start="2026-11-25", planned_end="2026-11-26")
    assert next_day["ok"] and next_day["errors"] == []


def test_every_unfinished_prerequisite_is_checked(board):
    result = check_change(board, "eval", planned_start="2026-11-26", planned_end="2026-11-28",
                          prerequisites=["train", "data"])
    assert not result["ok"]
    assert [e["relatedIds"] for e in result["errors"]] == [["train"]]  # data ends 11-24: fine


def test_clearing_dates_is_always_allowed(board):
    result = check_change(board, "data", planned_start=None, planned_end=None)
    assert result["ok"]
    # The scheduled dependent is told its prerequisite has no dates now.
    assert [(w["code"], w["taskId"]) for w in result["warnings"]] == [("prerequisite_unscheduled", "train")]


def test_unscheduled_prerequisite_is_only_a_warning(board):
    result = check_change(board, "idea", planned_start="2026-11-30", planned_end="2026-11-30",
                          prerequisites=["eval"])
    assert result["ok"]
    assert codes(result["warnings"]) == ["prerequisite_unscheduled"]


# ---------- dependency edits ----------

def test_adding_a_prerequisite_is_checked_against_existing_dates(board):
    result = check_change(board, "report", prerequisites=["train"])  # report 11-24, train ends 11-27
    assert not result["ok"]
    assert result["errors"][0]["code"] == "starts_before_prerequisite_ends"

    assert check_change(board, "report", prerequisites=["data"])["ok"] is False  # report starts the day data ends
    assert check_change(board, "report", prerequisites=[])["ok"] is True


@pytest.mark.parametrize("prereqs, message", [(["nope"], "Unknown prerequisite"), (["report"], "its own prerequisite")])
def test_invalid_prerequisite_lists_are_rejected(board, prereqs, message):
    with pytest.raises(ScheduleError, match=message):
        check_change(board, "report", prerequisites=prereqs)


# ---------- upstream date changes ----------

def test_moving_a_prerequisite_later_reports_broken_dependents(board):
    result = check_change(board, "data", planned_start="2026-11-23", planned_end="2026-11-25")
    assert not result["ok"]
    [err] = result["errors"]
    assert err["code"] == "ends_after_dependent_starts"
    assert err["taskId"] == "train" and err["relatedIds"] == ["data"]
    assert "Move “Train model” later first" in err["message"]
    # Nothing is rescheduled.
    assert board["train"]["planned_start"] == "2026-11-25"


def test_moving_a_prerequisite_earlier_is_fine(board):
    assert check_change(board, "data", planned_start="2026-11-20", planned_end="2026-11-21")["ok"]


def test_scheduling_an_unscheduled_prerequisite_checks_its_dependents(board):
    board["eval"].update(planned_start="2026-12-01", planned_end="2026-12-02")
    board["idea"]["prerequisites"] = []
    board["eval"]["prerequisites"] = ["train", "idea"]
    result = check_change(board, "idea", planned_start="2026-11-30", planned_end="2026-12-01")
    assert [(e["code"], e["taskId"]) for e in result["errors"]] == [("ends_after_dependent_starts", "eval")]


# ---------- completed tasks ----------

def test_completed_prerequisite_no_longer_constrains(board):
    board["data"]["status"] = "done"
    assert check_change(board, "train", planned_start="2026-11-23", planned_end="2026-11-24")["ok"]


def test_completed_dependent_is_not_broken_by_upstream_moves(board):
    board["train"]["status"] = "done"
    assert check_change(board, "data", planned_start="2026-11-23", planned_end="2026-11-30")["ok"]


def test_completed_task_is_not_checked_against_its_prerequisites(board):
    board["train"]["status"] = "done"
    assert check_change(board, "train", planned_start="2026-11-20", planned_end="2026-11-20")["ok"]


# ---------- same-member overlaps: warnings only ----------

def test_overlap_with_same_member_is_a_warning(board):
    result = check_change(board, "data", planned_start="2026-11-23", planned_end="2026-11-24")
    assert result["ok"]
    [w] = result["warnings"]
    assert w["code"] == "member_overlap" and w["relatedIds"] == ["report"]
    assert "2026-11-24 to 2026-11-24" in w["message"]


def test_reassigning_can_create_or_remove_overlaps(board):
    assert codes(check_change(board, "train", assignee_id="member-a")["warnings"]) == ["member_overlap"]  # report ends 11-25
    assert check_change(board, "report", assignee_id="member-c")["warnings"] == []


@pytest.mark.parametrize("change", [{"assignee_id": None}, {"planned_start": None, "planned_end": None}])
def test_no_overlap_without_member_or_dates(board, change):
    assert check_change(board, "report", **change)["warnings"] == []


def test_completed_tasks_do_not_overlap(board):
    board["report"]["status"] = "done"
    assert check_change(board, "data", planned_start="2026-11-23", planned_end="2026-11-24")["warnings"] == []


# ---------- general ----------

def test_check_change_never_modifies_the_board(board):
    before = copy.deepcopy(board)
    check_change(board, "data", planned_start="2026-11-23", planned_end="2026-11-30",
                 prerequisites=["idea"], assignee_id="member-b")
    assert board == before


def test_unknown_task_is_rejected(board):
    with pytest.raises(ScheduleError, match="Unknown task"):
        check_change(board, "missing", planned_start="2026-11-23", planned_end="2026-11-23")


def test_keep_leaves_fields_alone(board):
    changed = schedule.apply_change(board, "train", planned_end="2026-11-28")
    assert changed["train"]["planned_start"] == "2026-11-25" and changed["train"]["prerequisites"] == ["data"]


def test_board_issues_reports_stored_conflicts_and_overlaps(board):
    # Stored data can conflict, e.g. after a completed prerequisite is reopened.
    board["train"]["planned_start"] = "2026-11-24"
    issues = board_issues(board)
    assert codes(issues["train"]) == ["starts_before_prerequisite_ends"]
    assert codes(issues["data"]) == ["member_overlap"] and codes(issues["report"]) == ["member_overlap"]
    assert codes(issues["eval"]) == [] and issues["idea"] == []  # eval itself is unscheduled
