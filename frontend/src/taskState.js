/** Card state used for colours and Task Pool groups. Done wins over waiting. */
export function stateKind(task) {
  if (task.status === "done") return "done";
  return task.blocked ? "waiting" : "ready";
}
