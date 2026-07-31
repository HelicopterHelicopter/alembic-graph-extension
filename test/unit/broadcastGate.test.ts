import { describe, it, expect } from "vitest";
import { shouldDeliverStale, applyBusyMessage } from "../../src/core/broadcastGate";
import type { HostToWebviewMessage } from "../../src/protocol/messages";

type BusyMessage = Extract<HostToWebviewMessage, { type: "busy" }>;

describe("shouldDeliverStale", () => {
  it("1a. a terminal busy:false passes the gate (must survive a stale epoch)", () => {
    const msg: HostToWebviewMessage = { type: "busy", operation: "upgrade", token: "upgrade#1", active: false };
    expect(shouldDeliverStale(msg)).toBe(true);
  });

  it("1b. every busy operation kind's active:false passes, not just one hardcoded name", () => {
    const operations: BusyMessage["operation"][] = ["merge", "repoint", "upgrade", "downgrade", "scan", "revision", "sql"];
    for (const operation of operations) {
      expect(shouldDeliverStale({ type: "busy", operation, token: `${operation}#1`, active: false })).toBe(true);
    }
  });

  it("2a. a busy:true does NOT pass the gate (only the terminal clear is special-cased)", () => {
    const msg: HostToWebviewMessage = { type: "busy", operation: "upgrade", token: "upgrade#1", active: true };
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

describe("applyBusyMessage — token-scoped busy tracking", () => {
  it("5a. active:true adds the token; the matching active:false removes it", () => {
    const busyOps = new Set<string>();
    applyBusyMessage(busyOps, { type: "busy", operation: "merge", token: "merge#1", active: true });
    expect(busyOps.size).toBe(1);
    applyBusyMessage(busyOps, { type: "busy", operation: "merge", token: "merge#1", active: false });
    expect(busyOps.size).toBe(0);
  });

  it("5b. a stale busy:false with the SAME operation but a DIFFERENT token leaves the current op tracked", () => {
    const busyOps = new Set<string>();
    // The new project's upgrade starts...
    applyBusyMessage(busyOps, { type: "busy", operation: "upgrade", token: "upgrade#2", active: true });
    // ...then the OLD project's upgrade completes late (delivered stale on purpose — see
    // shouldDeliverStale). It must only be able to clear its own invocation's entry.
    applyBusyMessage(busyOps, { type: "busy", operation: "upgrade", token: "upgrade#1", active: false });
    expect(busyOps.size).toBe(1); // controls stay disabled while the new upgrade runs

    applyBusyMessage(busyOps, { type: "busy", operation: "upgrade", token: "upgrade#2", active: false });
    expect(busyOps.size).toBe(0);
  });

  it("5c. busy:false for a never-added token is a no-op (cancel paths post busy:false without busy:true)", () => {
    const busyOps = new Set<string>();
    applyBusyMessage(busyOps, { type: "busy", operation: "merge", token: "merge#9", active: false });
    expect(busyOps.size).toBe(0);
  });
});
