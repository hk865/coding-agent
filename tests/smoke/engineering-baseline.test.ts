import { describe, expect, it } from "vitest";

import { ENGINEERING_STATUS } from "../../src/public-api.js";

describe("engineering status", () => {
  it("暴露 M5 App、Provider、工具与恢复能力", () => {
    expect(ENGINEERING_STATUS).toEqual({
      milestone: "M5",
      agentCapabilities: true,
      contractsAvailable: true,
    });
  });
});
