import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseRevisionSource, extractFunctionBody } from "../../src/core/parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKEN_VERSIONS_DIR = path.join(here, "../../fixtures/broken-project/alembic/versions");
const BROKEN_ENV_PY = path.join(here, "../../fixtures/broken-project/alembic/env.py");

describe("parseRevisionSource", () => {
  it("1. parses a plain single-quote revision with down_revision = None (root)", () => {
    const src = `"""create products table

Revision ID: 8f2a1c9d4e07
Revises:
Create Date: 2026-05-01 10:01:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '8f2a1c9d4e07'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
`;
    const result = parseRevisionSource(src, "/fake/8f2a1c9d4e07_x.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("8f2a1c9d4e07");
    expect(result!.downRevisions).toEqual([]);
    expect(result!.branchLabels).toEqual([]);
    expect(result!.filePath).toBe("/fake/8f2a1c9d4e07_x.py");
  });

  it("2. parses a plain double-quote revision with a string down_revision", () => {
    const src = `"""some message

Create Date: 2026-01-01 00:00:00.000000
"""
revision = "abc123"
down_revision = "parent000"
branch_labels = None
depends_on = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("abc123");
    expect(result!.downRevisions).toEqual(["parent000"]);
  });

  it("3. parses annotated revision/down_revision forms (Union[str, Sequence[str], None])", () => {
    const src = `"""m"""
from typing import Sequence, Union

revision: str = "29dae0774a6c"
down_revision: Union[str, Sequence[str], None] = "18c9d9663f5b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("29dae0774a6c");
    expect(result!.downRevisions).toEqual(["18c9d9663f5b"]);
    expect(result!.branchLabels).toEqual([]);
  });

  it("4. parses the `: str | None` annotation form", () => {
    const src = `"""m"""
revision: str = "xyz"
down_revision: str | None = "parent1"
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("xyz");
    expect(result!.downRevisions).toEqual(["parent1"]);
  });

  it("5. parses tuple down_revision and single-element tuple branch_labels", () => {
    const src = `"""m"""
revision = "child1"
down_revision = ("parentA", "parentB")
branch_labels = ("billing",)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["parentA", "parentB"]);
    expect(result!.branchLabels).toEqual(["billing"]);
  });

  it("6. parses list-form down_revision and branch_labels", () => {
    const src = `"""m"""
revision = "child2"
down_revision = ["parentX", "parentY"]
branch_labels = ["featureA"]
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["parentX", "parentY"]);
    expect(result!.branchLabels).toEqual(["featureA"]);
  });

  it("7. ignores a trailing comment after the value", () => {
    const src = `"""m"""
revision = "rev1"  # noqa: keep
down_revision = "parentZ"  # some comment here
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("rev1");
    expect(result!.downRevisions).toEqual(["parentZ"]);
  });

  it("8. returns message '' when there is no docstring", () => {
    const src = `from alembic import op

revision = "norevdoc"
down_revision = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.message).toBe("");
  });

  it("9a. extracts the verbatim Create Date value when present", () => {
    const src = `"""add widgets

Revision ID: abc
Revises:
Create Date: 2026-03-04 12:34:56.789012

"""
revision = "abc"
down_revision = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.message).toBe("add widgets");
    expect(result!.createDate).toBe("2026-03-04 12:34:56.789012");
  });

  it("9b. createDate is null when the docstring has no Create Date line", () => {
    const src = `"""add widgets, no create date line"""
revision = "abc"
down_revision = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.createDate).toBeNull();
  });

  it("10a. ignores an indented (function-local) revision assignment in favor of the module-level one", () => {
    const src = `"""m"""
revision = "module_level"
down_revision = None


def upgrade() -> None:
    revision = "shadowed_local"
    print(revision)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("module_level");
  });

  it("10b. returns null when the only revision assignment is indented (no module-level one)", () => {
    const src = `"""m"""
def upgrade() -> None:
    revision = "only_local"
    print(revision)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).toBeNull();
  });

  it("11b. returns null for the real fixture env.py (no revision assignment)", () => {
    const src = readFileSync(BROKEN_ENV_PY, "utf8");
    expect(parseRevisionSource(src, BROKEN_ENV_PY)).toBeNull();
  });

  it("11. returns null for an env.py-like source with no revision assignment", () => {
    const src = `from logging.config import fileConfig

from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None


def run_migrations_offline() -> None:
    pass


def run_migrations_online() -> None:
    pass
`;
    const result = parseRevisionSource(src, "env.py");
    expect(result).toBeNull();
  });

  it("12. reports correct 0-based revisionLine and downRevisionLine, and null downRevisionLine when missing", () => {
    const src = `"""m"""
from alembic import op


revision = "lineid"
down_revision = "parentline"
branch_labels = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    // line 0: """m"""
    // line 1: from alembic import op
    // line 2: (blank)
    // line 3: (blank)
    // line 4: revision = "lineid"
    // line 5: down_revision = "parentline"
    expect(result!.revisionLine).toBe(4);
    expect(result!.downRevisionLine).toBe(5);

    const srcNoDownRevision = `"""m"""
revision = "onlyrev"
`;
    const result2 = parseRevisionSource(srcNoDownRevision, "f.py");
    expect(result2).not.toBeNull();
    expect(result2!.revisionLine).toBe(1);
    expect(result2!.downRevisionLine).toBeNull();
    expect(result2!.downRevisions).toEqual([]);
  });
});

describe("parseRevisionSource edge cases (self-review)", () => {
  it("handles CRLF line endings without breaking value parsing or line numbers", () => {
    const src = ['"""m"""', "", "revision = 'crlfrev'", "down_revision = 'crlfparent'", ""].join(
      "\r\n"
    );
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("crlfrev");
    expect(result!.downRevisions).toEqual(["crlfparent"]);
    expect(result!.revisionLine).toBe(2);
    expect(result!.downRevisionLine).toBe(3);
  });

  it("ignores a tab-indented (function-local) revision assignment", () => {
    const src = `"""m"""
revision = "module_level"
down_revision = None


def upgrade() -> None:
\trevision = "tab_shadowed"
\tprint(revision)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.revision).toBe("module_level");
  });

  it("only considers the first of multiple triple-quoted blocks as the module docstring", () => {
    const src = `"""first block

Create Date: 2026-02-02 00:00:00.000000
"""
revision = "multidoc"
down_revision = None

SQL = """second block, not the docstring

Create Date: 1999-01-01 00:00:00.000000
"""
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.message).toBe("first block");
    expect(result!.createDate).toBe("2026-02-02 00:00:00.000000");
  });
});

describe("parseRevisionSource bracket-spanning down_revision / branch_labels (multi-line tuple/list values)", () => {
  it("parses a multi-line tuple down_revision spanning several lines (merge revision)", () => {
    const src = `"""m"""
revision = "child1"
down_revision = (
    "18c9d9663f5b",
    "07b8c8552e4a",
)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["18c9d9663f5b", "07b8c8552e4a"]);
    // line 0: """m"""
    // line 1: revision = "child1"
    // line 2: down_revision = (
    expect(result!.downRevisionLine).toBe(2);
  });

  it("parses a multi-line single-element tuple branch_labels", () => {
    const src = `"""m"""
revision = "child1"
down_revision = None
branch_labels = (
    "billing",
)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.branchLabels).toEqual(["billing"]);
  });

  it("parses a multi-line list-form down_revision", () => {
    const src = `"""m"""
revision = "child2"
down_revision = [
    "parentX",
    "parentY",
]
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["parentX", "parentY"]);
  });

  it("ignores trailing comments on continuation lines inside a multi-line tuple", () => {
    const src = `"""m"""
revision = "child3"
down_revision = (  # merge of two parents
    "18c9d9663f5b",  # first parent
    "07b8c8552e4a",  # second parent
)
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["18c9d9663f5b", "07b8c8552e4a"]);
  });

  it("keeps downRevisionLine pointing at the assignment's first line, not the closing bracket", () => {
    const src = `"""m"""
revision = "child4"


down_revision = (
    "18c9d9663f5b",
    "07b8c8552e4a",
)
branch_labels = None
`;
    const result = parseRevisionSource(src, "f.py");
    expect(result).not.toBeNull();
    // line 0: """m"""
    // line 1: revision = "child4"
    // line 2: (blank)
    // line 3: (blank)
    // line 4: down_revision = (
    expect(result!.downRevisionLine).toBe(4);
    expect(result!.downRevisions).toEqual(["18c9d9663f5b", "07b8c8552e4a"]);
  });
});

describe("extractFunctionBody", () => {
  it("13a. extracts a normal multi-statement body, dedented", () => {
    const src = `def upgrade() -> None:
    op.create_table(
        "widgets",
        sa.Column("id", sa.Integer(), primary_key=True),
    )


def downgrade() -> None:
    op.drop_table("widgets")
`;
    const body = extractFunctionBody(src, "upgrade");
    expect(body).toBe(
      'op.create_table(\n    "widgets",\n    sa.Column("id", sa.Integer(), primary_key=True),\n)'
    );
  });

  it("13b. handles def with -> None return annotation and varied spacing", () => {
    const src = `def downgrade()->None:
    op.drop_table("widgets")
`;
    const body = extractFunctionBody(src, "downgrade");
    expect(body).toBe('op.drop_table("widgets")');
  });

  it("13c. a body of just `pass` returns \"pass\"", () => {
    const src = `def upgrade():
    pass


def downgrade():
    pass
`;
    expect(extractFunctionBody(src, "upgrade")).toBe("pass");
    expect(extractFunctionBody(src, "downgrade")).toBe("pass");
  });

  it("13d. returns null when the function is absent", () => {
    const src = `def upgrade() -> None:
    pass
`;
    expect(extractFunctionBody(src, "downgrade")).toBeNull();
  });

  it("13e. stops the body at the next top-level def", () => {
    const src = `def upgrade() -> None:
    op.create_table("a")
def downgrade() -> None:
    op.drop_table("a")
`;
    expect(extractFunctionBody(src, "upgrade")).toBe('op.create_table("a")');
    expect(extractFunctionBody(src, "downgrade")).toBe('op.drop_table("a")');
  });

  it("13f. keeps nested indentation (an if inside upgrade stays in the body) and dedents correctly", () => {
    const src = `def upgrade() -> None:
    if True:
        op.create_table("a")
    else:
        op.create_table("b")
`;
    const body = extractFunctionBody(src, "upgrade");
    expect(body).toBe('if True:\n    op.create_table("a")\nelse:\n    op.create_table("b")');
  });
});

describe("fixture integration: fixtures/broken-project/alembic/versions", () => {
  const files = readdirSync(BROKEN_VERSIONS_DIR).filter((f) => f.endsWith(".py"));

  it("14a. has exactly 12 revision files in the fixture", () => {
    expect(files.length).toBe(12);
  });

  it("14b. every file parses to a non-null ParsedRevision", () => {
    for (const file of files) {
      const src = readFileSync(path.join(BROKEN_VERSIONS_DIR, file), "utf8");
      const result = parseRevisionSource(src, file);
      expect(result, `expected ${file} to parse`).not.toBeNull();
    }
  });

  it("14c. parsed revision ids are exactly the 12 expected ids", () => {
    const ids = files
      .map((file) => {
        const src = readFileSync(path.join(BROKEN_VERSIONS_DIR, file), "utf8");
        return parseRevisionSource(src, file)!.revision;
      })
      .sort();
    const expected = [
      "07b8c8552e4a",
      "18c9d9663f5b",
      "29dae0774a6c",
      "3aebf1885b7d",
      "4bfc02996c8e",
      "5c0d13aa7d9f",
      "8f2a1c9d4e07",
      "b2e5d3a10f66",
      "c3d6e4b721a8",
      "d4c7f5309b2e",
      "e5b8a600cc11",
      "f6a9b7241d3c",
    ].sort();
    expect(ids).toEqual(expected);
  });

  function parseByRevisionId(id: string) {
    for (const file of files) {
      const src = readFileSync(path.join(BROKEN_VERSIONS_DIR, file), "utf8");
      const result = parseRevisionSource(src, file);
      if (result?.revision === id) return result;
    }
    return null;
  }

  it("14d. 29dae0774a6c has downRevisions [18c9d9663f5b, 07b8c8552e4a]", () => {
    const result = parseByRevisionId("29dae0774a6c");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["18c9d9663f5b", "07b8c8552e4a"]);
  });

  it("14e. f6a9b7241d3c has branchLabels [billing]", () => {
    const result = parseByRevisionId("f6a9b7241d3c");
    expect(result).not.toBeNull();
    expect(result!.branchLabels).toEqual(["billing"]);
  });

  it("14f. 5c0d13aa7d9f has downRevisions [deadbeef0000] (broken link)", () => {
    const result = parseByRevisionId("5c0d13aa7d9f");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual(["deadbeef0000"]);
  });

  it("14g. root 8f2a1c9d4e07 has downRevisions []", () => {
    const result = parseByRevisionId("8f2a1c9d4e07");
    expect(result).not.toBeNull();
    expect(result!.downRevisions).toEqual([]);
  });
});
