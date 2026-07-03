import { describe, it, expect } from "vitest";
import { computeRepointedSource } from "../../src/core/repoint";

describe("computeRepointedSource", () => {
  it("1a. scalar single-quote down_revision: quote style preserved, byte-identical elsewhere", () => {
    const src = `"""add audit log

Revision ID: 5c0d13aa7d9f
Revises: deadbeef0000
Create Date: 2026-05-12 10:12:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5c0d13aa7d9f'
down_revision = 'deadbeef0000'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('audit_log')


def downgrade() -> None:
    op.drop_table('audit_log')
`;
    const expected = src.replace("Revises: deadbeef0000", "Revises: 4bfc02996c8e").replace(
      "down_revision = 'deadbeef0000'",
      "down_revision = '4bfc02996c8e'",
    );
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("1b. scalar double-quote down_revision: quote style preserved", () => {
    const src = `"""m"""
revision = "child1"
down_revision = "deadbeef0000"
`;
    const expected = `"""m"""
revision = "child1"
down_revision = "4bfc02996c8e"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("2. tuple member: only the matching member changes, the other + formatting untouched", () => {
    const src = `"""m"""
revision = "child1"
down_revision = ("18c9d9663f5b", "deadbeef0000")
`;
    const expected = `"""m"""
revision = "child1"
down_revision = ("18c9d9663f5b", "4bfc02996c8e")
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("3. multi-line tuple with trailing comments: only the target quoted span changes", () => {
    const src = `"""m"""
revision = "child3"
down_revision = (  # merge of two parents
    "18c9d9663f5b",  # first parent
    "deadbeef0000",  # second parent
)
`;
    const expected = `"""m"""
revision = "child3"
down_revision = (  # merge of two parents
    "18c9d9663f5b",  # first parent
    "4bfc02996c8e",  # second parent
)
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("4. annotated Union[...] scalar form", () => {
    const src = `"""m"""
revision: str = "child1"
down_revision: Union[str, Sequence[str], None] = "deadbeef0000"
branch_labels: Union[str, Sequence[str], None] = None
`;
    const expected = `"""m"""
revision: str = "child1"
down_revision: Union[str, Sequence[str], None] = "4bfc02996c8e"
branch_labels: Union[str, Sequence[str], None] = None
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("5a. Revises: bare (single id) docstring line patched alongside down_revision", () => {
    const src = `"""add audit log

Revision ID: 5c0d13aa7d9f
Revises: deadbeef0000
Create Date: 2026-05-12 10:12:00.000000

"""
revision = "5c0d13aa7d9f"
down_revision = "deadbeef0000"
`;
    const expected = `"""add audit log

Revision ID: 5c0d13aa7d9f
Revises: 4bfc02996c8e
Create Date: 2026-05-12 10:12:00.000000

"""
revision = "5c0d13aa7d9f"
down_revision = "4bfc02996c8e"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("5b. Revises: comma-separated list — only the matching token is replaced", () => {
    const src = `"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises: 18c9d9663f5b, deadbeef0000
Create Date: 2026-05-09 10:09:00.000000

"""
revision: str = "29dae0774a6c"
down_revision: Union[str, Sequence[str], None] = ("18c9d9663f5b", "deadbeef0000")
`;
    const expected = `"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises: 18c9d9663f5b, cafebabe0001
Create Date: 2026-05-09 10:09:00.000000

"""
revision: str = "29dae0774a6c"
down_revision: Union[str, Sequence[str], None] = ("18c9d9663f5b", "cafebabe0001")
`;
    const result = computeRepointedSource(src, "deadbeef0000", "cafebabe0001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("6. no docstring at all: down_revision still patched, no error", () => {
    const src = `revision = "child1"
down_revision = "deadbeef0000"
`;
    const expected = `revision = "child1"
down_revision = "4bfc02996c8e"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("7. missingId not present in down_revision value -> error, src untouched (no newSrc)", () => {
    const src = `"""m"""
revision = "child1"
down_revision = "18c9d9663f5b"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result).toEqual({ ok: false, reason: "down_revision does not reference deadbeef" });
  });

  it("7b. no down_revision assignment at all -> same 'does not reference' error", () => {
    const src = `"""m"""
revision = "child1"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result).toEqual({ ok: false, reason: "down_revision does not reference deadbeef" });
  });

  it("8. targetId already present as another member -> error, no dedupe magic", () => {
    const src = `"""m"""
revision = "child1"
down_revision = ("18c9d9663f5b", "deadbeef0000")
`;
    const result = computeRepointedSource(src, "deadbeef0000", "18c9d9663f5b");
    expect(result).toEqual({ ok: false, reason: "already revises 18c9d966" });
  });

  it("9. preserves CRLF line endings byte-for-byte outside the replaced token", () => {
    const src = ['"""m"""', 'revision = "child1"', 'down_revision = "deadbeef0000"', ""].join("\r\n");
    const expected = ['"""m"""', 'revision = "child1"', 'down_revision = "4bfc02996c8e"', ""].join("\r\n");
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("10. comment on the opening line quotes missingId, real member is on a continuation line: the real member is replaced, the comment is byte-identical", () => {
    const src = `"""m"""
revision = "child1"
down_revision = (  # replaces "deadbeef0000"
    "deadbeef0000",
)
`;
    const expected = `"""m"""
revision = "child1"
down_revision = (  # replaces "deadbeef0000"
    "4bfc02996c8e",
)
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("11. targetId appears only in a trailing comment, not as a real member: not treated as already-present", () => {
    const src = `"""m"""
revision = "child1"
down_revision = "deadbeef0000"  # was previously "4bfc02996c8e"
`;
    const expected = `"""m"""
revision = "child1"
down_revision = "4bfc02996c8e"  # was previously "4bfc02996c8e"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("12. patchRevisesLine keeps scanning past an earlier Revises: line that doesn't mention missingId", () => {
    const src = `"""merge note

Revises: 18c9d9663f5b

The actual predecessor:
Revises: deadbeef0000
"""
revision = "child1"
down_revision = "deadbeef0000"
`;
    const expected = `"""merge note

Revises: 18c9d9663f5b

The actual predecessor:
Revises: 4bfc02996c8e
"""
revision = "child1"
down_revision = "4bfc02996c8e"
`;
    const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });
});
