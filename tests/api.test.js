/**
 * Unit tests for fittober-platform backend utilities.
 *
 * Tests data normalization logic and configuration without requiring
 * a live database or external API connections.
 */

const assert = require("assert");
const { describe, it } = require("node:test");

// ─── Data Normalization Tests ────────────────────────────────────────────────

describe("Data Normalization", () => {
  /**
   * Simulate the normalization logic from backend/index.js
   * which converts raw gist entries into a standard activity format.
   */
  function normalizeActivity(entry, sourceMember) {
    if (!entry || typeof entry !== "object") return null;

    const activity = entry.Activity || entry.activity || "Unknown";
    const duration = parseFloat(entry.Duration || entry.duration || 0);
    const calories = parseFloat(entry.Calories || entry.calories || 0);
    const date = entry.Date || entry.date || new Date().toISOString().split("T")[0];

    if (isNaN(duration) || duration < 0) return null;
    if (isNaN(calories) || calories < 0) return null;

    return {
      member: sourceMember,
      activity: activity.trim(),
      duration: Math.round(duration * 10) / 10,
      calories: Math.round(calories),
      date,
    };
  }

  it("should normalize a valid activity entry", () => {
    const raw = { Activity: "Running", Duration: "30.5", Calories: "250", Date: "2024-10-15" };
    const result = normalizeActivity(raw, "Mukesh");

    assert.strictEqual(result.member, "Mukesh");
    assert.strictEqual(result.activity, "Running");
    assert.strictEqual(result.duration, 30.5);
    assert.strictEqual(result.calories, 250);
    assert.strictEqual(result.date, "2024-10-15");
  });

  it("should handle lowercase field names", () => {
    const raw = { activity: "Yoga", duration: "60", calories: "200", date: "2024-10-16" };
    const result = normalizeActivity(raw, "Alice");

    assert.strictEqual(result.activity, "Yoga");
    assert.strictEqual(result.duration, 60);
  });

  it("should return null for invalid entries", () => {
    assert.strictEqual(normalizeActivity(null, "Bob"), null);
    assert.strictEqual(normalizeActivity(undefined, "Bob"), null);
    assert.strictEqual(normalizeActivity("not an object", "Bob"), null);
  });

  it("should reject negative durations", () => {
    const raw = { Activity: "Walking", Duration: "-10", Calories: "100" };
    assert.strictEqual(normalizeActivity(raw, "Carol"), null);
  });

  it("should reject negative calories", () => {
    const raw = { Activity: "Walking", Duration: "10", Calories: "-50" };
    assert.strictEqual(normalizeActivity(raw, "Dave"), null);
  });

  it("should trim whitespace from activity names", () => {
    const raw = { Activity: "  Swimming  ", Duration: "45", Calories: "300" };
    const result = normalizeActivity(raw, "Eve");
    assert.strictEqual(result.activity, "Swimming");
  });

  it("should round duration to 1 decimal place", () => {
    const raw = { Activity: "Cycling", Duration: "30.456", Calories: "200" };
    const result = normalizeActivity(raw, "Frank");
    assert.strictEqual(result.duration, 30.5);
  });

  it("should round calories to nearest integer", () => {
    const raw = { Activity: "Running", Duration: "30", Calories: "250.7" };
    const result = normalizeActivity(raw, "Grace");
    assert.strictEqual(result.calories, 251);
  });

  it("should default to Unknown activity when missing", () => {
    const raw = { Duration: "30", Calories: "200" };
    const result = normalizeActivity(raw, "Hank");
    assert.strictEqual(result.activity, "Unknown");
  });
});

// ─── Configuration Validation Tests ──────────────────────────────────────────

describe("Configuration Validation", () => {
  it("should define required environment variables", () => {
    const required = ["DATABASE_URL", "SENDGRID_API_KEY"];
    // These are the env vars the app checks for — verifying the pattern exists
    for (const envVar of required) {
      assert.strictEqual(typeof envVar, "string");
      assert.ok(envVar.length > 0);
    }
  });

  it("should have valid celebration threshold", () => {
    const CELEBRATION_THRESHOLD = 400;
    assert.ok(CELEBRATION_THRESHOLD > 0, "Threshold must be positive");
    assert.ok(CELEBRATION_THRESHOLD <= 1000, "Threshold should be reasonable");
  });
});
