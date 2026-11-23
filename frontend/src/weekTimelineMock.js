/*
 * Mock board for the WeekTimeline preview (timelinePreview.jsx). Dates are
 * relative to the current week so the preview always has something to show.
 * Field names follow the planned API: plannedStart / plannedEnd / workHours.
 */
import { addDays, startOfWeek, toDateStr } from "./WeekTimeline.jsx";

export function makeMockBoard(today = toDateStr(new Date())) {
  const mon = startOfWeek(today);
  const d = (n) => addDays(mon, n); // d(0) = Monday of this week

  const members = [
    { id: "member-a", name: "Member A" },
    { id: "member-b", name: "Member B" },
    { id: "member-c", name: "Member C" },
    { id: "member-d", name: "Member D" },
  ];

  const tasks = [
    { id: "collect", title: "Collect new rollouts", status: "done", blocked: false,
      assigneeId: "member-a", plannedStart: d(-3), plannedEnd: d(0), workHours: 10, prerequisites: [] },
    { id: "clean", title: "Clean dataset", status: "todo", blocked: false,
      assigneeId: "member-a", plannedStart: d(1), plannedEnd: d(2), workHours: 8, prerequisites: ["collect"] },
    { id: "report", title: "Write weekly report", status: "todo", blocked: false,
      assigneeId: "member-a", plannedStart: d(2), plannedEnd: d(3), workHours: 4, prerequisites: [] },
    { id: "train", title: "Train policy", status: "todo", blocked: true,
      assigneeId: "member-b", plannedStart: d(3), plannedEnd: d(5), workHours: 6, prerequisites: ["clean"] },
    { id: "eval", title: "Evaluate checkpoint", status: "todo", blocked: true,
      assigneeId: "member-c", plannedStart: d(5), plannedEnd: d(9), workHours: 12, prerequisites: ["train"] },
    { id: "gpu-check", title: "GPU overlap check", status: "todo", blocked: false,
      assigneeId: "member-d", plannedStart: d(0), plannedEnd: d(0), workHours: 3, prerequisites: [] },
    // Task Pool: no planned dates (one already has an owner).
    { id: "prompts", title: "Write 10 prompt test cases", status: "todo", blocked: false,
      assigneeId: "member-c", plannedStart: null, plannedEnd: null, workHours: 5, prerequisites: [] },
    { id: "picker", title: "Add prerequisite picker", status: "todo", blocked: false,
      assigneeId: null, plannedStart: null, plannedEnd: null, workHours: 16, prerequisites: [] },
    { id: "docs", title: "Update demo guide", status: "todo", blocked: false,
      assigneeId: null, plannedStart: null, plannedEnd: null, workHours: null, prerequisites: [] },
  ];

  // Static examples of what backend/schedule.py will report for this data.
  const issuesByTask = {
    clean: [{ severity: "warning", message: "“Clean dataset” overlaps “Write weekly report” for the same member." }],
    report: [{ severity: "warning", message: "“Write weekly report” overlaps “Clean dataset” for the same member." }],
  };

  return { members, tasks, issuesByTask, today };
}
