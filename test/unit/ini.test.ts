import { describe, it, expect } from "vitest";
import { parseScriptLocation } from "../../src/core/ini";

describe("parseScriptLocation", () => {
  it("1. parses a plain script_location under [alembic]", () => {
    const ini = `[alembic]\nscript_location = alembic\n`;
    expect(parseScriptLocation(ini)).toBe("alembic");
  });

  it("2. passes through %(here)s untouched (resolution happens in discovery)", () => {
    const ini = `[alembic]\nscript_location = %(here)s/alembic\n`;
    expect(parseScriptLocation(ini)).toBe("%(here)s/alembic");
  });

  it("3. accepts a ':' separator", () => {
    const ini = `[alembic]\nscript_location: alembic\n`;
    expect(parseScriptLocation(ini)).toBe("alembic");
  });

  it("4. returns null when [alembic] exists but has no script_location key", () => {
    const ini = `[alembic]\nsqlalchemy.url = sqlite:///fixture.db\n`;
    expect(parseScriptLocation(ini)).toBeNull();
  });

  it("5. returns null when there is no [alembic] section at all", () => {
    const ini = `[loggers]\nkeys = root\n`;
    expect(parseScriptLocation(ini)).toBeNull();
  });

  it("6. returns null when script_location only appears in a DIFFERENT section", () => {
    const ini = `[alembic]\nsqlalchemy.url = sqlite:///fixture.db\n\n[alembic:other]\nscript_location = other\n`;
    expect(parseScriptLocation(ini)).toBeNull();
  });

  it("7. ignores a commented-out script_location line", () => {
    const ini = `[alembic]\n# script_location = commented\n`;
    expect(parseScriptLocation(ini)).toBeNull();
  });

  describe("edge cases (self-review)", () => {
    it("finds the real value even when a commented-out line precedes it", () => {
      const ini = `[alembic]\n; script_location = commented\nscript_location = real\n`;
      expect(parseScriptLocation(ini)).toBe("real");
    });

    it("tolerates leading/trailing whitespace around key and value", () => {
      const ini = `[alembic]\n   script_location   =   alembic   \n`;
      expect(parseScriptLocation(ini)).toBe("alembic");
    });

    it("is case-sensitive on the key: 'Script_Location' does not match", () => {
      const ini = `[alembic]\nScript_Location = alembic\n`;
      expect(parseScriptLocation(ini)).toBeNull();
    });

    it("stops honoring the [alembic] section once a later section starts", () => {
      const ini = `[alembic]\nsqlalchemy.url = sqlite:///fixture.db\n\n[loggers]\nscript_location = leaked\n`;
      expect(parseScriptLocation(ini)).toBeNull();
    });

    it("handles CRLF line endings", () => {
      const ini = ["[alembic]", "script_location = alembic"].join("\r\n");
      expect(parseScriptLocation(ini)).toBe("alembic");
    });

    it("returns null on an empty ini file", () => {
      expect(parseScriptLocation("")).toBeNull();
    });
  });
});
