/*
 * Booked GPU hours compared with the estimated GPU hours, for the GPU section
 * of the task details. Booking more than the estimate is allowed (estimates
 * can be low); it is shown as a plain note, never as a schedule conflict.
 */
import { formatHours } from "./gpuState.js";

/** { booked, kind: "none" | "partial" | "covered" | "over" | "unknown", text } */
export function bookingProgress(task) {
  const booked = task.bookedGpuHours || 0;
  if (booked === 0) return { booked, kind: "none", text: "Nothing booked yet" };
  if (task.gpuHours == null) return { booked, kind: "unknown", text: "No estimate to compare with" };
  const diff = Math.round((booked - task.gpuHours) * 2) / 2; // half-hour grid, like the bookings
  if (diff < 0) return { booked, kind: "partial", text: `${formatHours(-diff)} left to book` };
  if (diff === 0) return { booked, kind: "covered", text: "Covers the estimate" };
  return { booked, kind: "over", text: `${formatHours(diff)} more than estimated` };
}
