// Run with: npm test (from frontend/).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingProgress } from "./gpuProgress.js";

const gpuTask = (gpuHours, bookedGpuHours) => ({ needsGpu: true, gpuHours, bookedGpuHours });

test("no bookings yet", () => {
  assert.deepEqual(bookingProgress(gpuTask(6, 0)), { booked: 0, kind: "none", text: "Nothing booked yet" });
  assert.equal(bookingProgress({ needsGpu: true, gpuHours: 6 }).kind, "none"); // field missing
});

test("partly booked: shows what is left", () => {
  assert.deepEqual(bookingProgress(gpuTask(6, 2)), { booked: 2, kind: "partial", text: "4h left to book" });
  assert.equal(bookingProgress(gpuTask(6, 4.5)).text, "1.5h left to book");
});

test("estimate exactly covered", () => {
  assert.deepEqual(bookingProgress(gpuTask(6, 6)), { booked: 6, kind: "covered", text: "Covers the estimate" });
});

test("booked more than estimated: the difference is shown, not 'fully booked'", () => {
  const p = bookingProgress(gpuTask(6, 9));
  assert.deepEqual(p, { booked: 9, kind: "over", text: "3h more than estimated" });
  assert.equal(bookingProgress(gpuTask(4, 4.5)).text, "0.5h more than estimated");
});

test("no estimate to compare with", () => {
  assert.equal(bookingProgress(gpuTask(null, 3)).kind, "unknown");
  assert.equal(bookingProgress(gpuTask(null, 0)).kind, "none");
});
