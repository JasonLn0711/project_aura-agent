import { describe, expect, it } from "vitest";
import { ActionSchema, canDelegate } from "../src/index";

const supportedAction = ActionSchema.parse({
  id: "action-1",
  title: "限制 ASR 佇列並加入背壓",
  owner: "Jason",
  status: "confirmed",
  support: "supported",
  acceptance: ["佇列容量有明確上限"],
  evidence: [
    { id: "seg-1", kind: "segment", locator: "session/demo/segments/1" },
  ],
});

describe("delegation gate", () => {
  it("opens only for confirmed, supported, sourced actions", () => {
    expect(canDelegate(supportedAction)).toBe(true);
    expect(canDelegate({ ...supportedAction, support: "partial" })).toBe(false);
    expect(canDelegate({ ...supportedAction, status: "proposed" })).toBe(false);
    expect(canDelegate({ ...supportedAction, evidence: [] })).toBe(false);
  });

  it("keeps work classification source-backed and optional", () => {
    expect(supportedAction.workType).toBeUndefined();
    expect(
      ActionSchema.parse({
        ...supportedAction,
        workType: "non-engineering",
      }).workType,
    ).toBe("non-engineering");
    expect(
      ActionSchema.safeParse({
        ...supportedAction,
        workType: "guessed-from-title",
      }).success,
    ).toBe(false);
  });
});
