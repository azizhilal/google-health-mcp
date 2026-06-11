import { describe, it, expect } from "vitest";
import { pruneEnvelope, toLeanJson } from "./shape";

describe("pruneEnvelope", () => {
  it("strips noise keys while keeping value and timestamp fields", () => {
    const point = {
      name: "users/me/dataTypes/sleep/dataPoints/abc",
      dataSource: { device: { model: "Pixel Watch" }, application: { name: "Fitbit" } },
      originDataPointId: "xyz",
      createTime: "2026-06-10T08:00:00Z",
      updateTime: "2026-06-10T09:00:00Z",
      interval: { startTime: "2026-06-09T23:00:00Z", endTime: "2026-06-10T07:00:00Z" },
      value: { sleep: { summary: { deepMinutes: 90 } } },
    };
    expect(pruneEnvelope(point)).toEqual({
      interval: { startTime: "2026-06-09T23:00:00Z", endTime: "2026-06-10T07:00:00Z" },
      value: { sleep: { summary: { deepMinutes: 90 } } },
    });
  });

  it("prunes inside arrays and nested response envelopes", () => {
    const resp = {
      dataPoints: [
        { name: "p1", value: { heartRate: { beatsPerMinute: 55 } } },
        { name: "p2", value: { heartRate: { beatsPerMinute: 58 } } },
      ],
    };
    expect(pruneEnvelope(resp)).toEqual({
      dataPoints: [
        { value: { heartRate: { beatsPerMinute: 55 } } },
        { value: { heartRate: { beatsPerMinute: 58 } } },
      ],
    });
  });

  it("leaves primitives and clean objects untouched", () => {
    expect(pruneEnvelope({ window: { start: "2026-06-01", end: "2026-06-07" } })).toEqual({
      window: { start: "2026-06-01", end: "2026-06-07" },
    });
  });
});

describe("toLeanJson", () => {
  it("serializes compactly with no pretty-print whitespace", () => {
    const json = toLeanJson({ a: 1, b: [2, 3] });
    expect(json).toBe('{"a":1,"b":[2,3]}');
    expect(json).not.toContain("\n");
  });
});
