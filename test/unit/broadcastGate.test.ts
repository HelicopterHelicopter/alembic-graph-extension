import { describe, it, expect } from "vitest";
import { shouldDeliverStale } from "../../src/core/broadcastGate";
import type { HostToWebviewMessage } from "../../src/protocol/messages";

type BusyMessage = Extract<HostToWebviewMessage, { type: "busy" }>;

describe("shouldDeliverStale", () => {
  it("1a. a terminal busy:false passes the gate (must survive a stale epoch)", () => {
    const msg: HostToWebviewMessage = { type: "busy", operation: "upgrade", active: false };
    expect(shouldDeliverStale(msg)).toBe(true);
  });

  it("1b. every busy operation kind's active:false passes, not just one hardcoded name", () => {
    const operations: BusyMessage["operation"][] = ["merge", "repoint", "upgrade", "downgrade", "scan", "revision", "sql"];
    for (const operation of operations) {
      expect(shouldDeliverStale({ type: "busy", operation, active: false })).toBe(true);
    }
  });

  it("2a. a busy:true does NOT pass the gate (only the terminal clear is special-cased)", () => {
    const msg: HostToWebviewMessage = { type: "busy", operation: "upgrade", active: true };
    expect(shouldDeliverStale(msg)).toBe(false);
  });

  it("3a. a toast does NOT pass the gate", () => {
    const msg: HostToWebviewMessage = { type: "toast", level: "success", text: "Upgraded to heads" };
    expect(shouldDeliverStale(msg)).toBe(false);
  });

  it("3b. an error toast does NOT pass the gate either", () => {
    const msg: HostToWebviewMessage = { type: "toast", level: "error", text: "alembic upgrade failed" };
    expect(shouldDeliverStale(msg)).toBe(false);
  });

  it("4a. state/detail/selectNode/noProject/busyReset all do NOT pass the gate", () => {
    const messages: HostToWebviewMessage[] = [
      { type: "selectNode", id: "abc123" },
      { type: "noProject" },
      { type: "busyReset" },
      { type: "detail", forId: null, detail: null },
    ];
    for (const msg of messages) {
      expect(shouldDeliverStale(msg)).toBe(false);
    }
  });
});
