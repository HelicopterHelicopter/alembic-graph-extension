import { describe, it, expect } from "vitest";
import { computeDownRevisionsRewrite } from "../../src/core/downRevisionEdit";

describe("computeDownRevisionsRewrite", () => {
  it("1. scalar -> scalar: single quotes preserved, Revises: patched, byte-identical elsewhere", () => {
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
    const expected = `"""add audit log

Revision ID: 5c0d13aa7d9f
Revises: 4bfc02996c8e
Create Date: 2026-05-12 10:12:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5c0d13aa7d9f'
down_revision = '4bfc02996c8e'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('audit_log')


def downgrade() -> None:
    op.drop_table('audit_log')
`;
    const result = computeDownRevisionsRewrite(src, ["4bfc02996c8e"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("2. scalar -> tuple of two: Revises: becomes a comma list", () => {
    const src = `"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises: 18c9d9663f5b
Create Date: 2026-05-09 10:09:00.000000

"""
revision = "29dae0774a6c"
down_revision = "18c9d9663f5b"
`;
    const expected = `"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises: 18c9d9663f5b, 07b8c8552e4a
Create Date: 2026-05-09 10:09:00.000000

"""
revision = "29dae0774a6c"
down_revision = ("18c9d9663f5b", "07b8c8552e4a")
`;
    const result = computeDownRevisionsRewrite(src, ["18c9d9663f5b", "07b8c8552e4a"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("3. tuple -> scalar: quote taken from the first old member, not from the revision line", () => {
    const src = `"""m"""
revision = 'child3'
down_revision = ("18c9d9663f5b", "07b8c8552e4a")
`;
    const expected = `"""m"""
revision = 'child3'
down_revision = "18c9d9663f5b"
`;
    const result = computeDownRevisionsRewrite(src, ["18c9d9663f5b"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("4. tuple -> None: value becomes None and the Revises: line loses its ids and trailing space", () => {
    const src = `"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises: 18c9d9663f5b, 07b8c8552e4a
Create Date: 2026-05-09 10:09:00.000000

"""
revision = "29dae0774a6c"
down_revision = ("18c9d9663f5b", "07b8c8552e4a")
`;
    const expected = `"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises:
Create Date: 2026-05-09 10:09:00.000000

"""
revision = "29dae0774a6c"
down_revision = None
`;
    const result = computeDownRevisionsRewrite(src, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newSrc).toBe(expected);
      // Guard against an invisible trailing space surviving in the template literal above.
      expect(result.newSrc).toContain("\nRevises:\n");
    }
  });

  it("5. None -> scalar: quote borrowed from the revision assignment", () => {
    const src = `"""m"""
revision = 'child1'
down_revision = None
`;
    const expected = `"""m"""
revision = 'child1'
down_revision = '18c9d9663f5b'
`;
    const result = computeDownRevisionsRewrite(src, ["18c9d9663f5b"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("6. None -> tuple", () => {
    const src = `"""m"""
revision = "child1"
down_revision = None
`;
    const expected = `"""m"""
revision = "child1"
down_revision = ("18c9d9663f5b", "07b8c8552e4a")
`;
    const result = computeDownRevisionsRewrite(src, ["18c9d9663f5b", "07b8c8552e4a"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("7. annotated left-hand side is preserved byte-for-byte", () => {
    const src = `"""m"""
revision: str = "child1"
down_revision: Union[str, Sequence[str], None] = "18c9d9663f5b"
branch_labels: Union[str, Sequence[str], None] = None
`;
    const expected = `"""m"""
revision: str = "child1"
down_revision: Union[str, Sequence[str], None] = "07b8c8552e4a"
branch_labels: Union[str, Sequence[str], None] = None
`;
    const result = computeDownRevisionsRewrite(src, ["07b8c8552e4a"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("8. Black-style multi-line tuple collapses to one line, continuation comments dropped", () => {
    const src = `"""m"""
revision = "child3"
down_revision = (
    "18c9d9663f5b",  # first parent
    "07b8c8552e4a",  # second parent
)
`;
    const expected = `"""m"""
revision = "child3"
down_revision = "18c9d9663f5b"
`;
    const result = computeDownRevisionsRewrite(src, ["18c9d9663f5b"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("9. quote choice ignores quotes that live inside a comment", () => {
    const src = `"""m"""
revision = "child1"
down_revision = (  # replaces "zzz"
    'aaa11111111',
    'bbb22222222',
)
`;
    const expected = `"""m"""
revision = "child1"
down_revision = 'ccc33333333'  # replaces "zzz"
`;
    const result = computeDownRevisionsRewrite(src, ["ccc33333333"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("10. trailing comment on the assignment line is preserved", () => {
    const src = `"""m"""
revision = "child1"
down_revision = 'aaa11111111'  # keep me
`;
    const expected = `"""m"""
revision = "child1"
down_revision = 'bbb22222222'  # keep me
`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("11. CRLF line endings are preserved byte-for-byte", () => {
    const src = ['"""m"""', 'revision = "child1"', 'down_revision = "aaa11111111"', ""].join("\r\n");
    const expected = ['"""m"""', 'revision = "child1"', 'down_revision = "bbb22222222"', ""].join("\r\n");
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("12. file without a trailing newline still ends without one", () => {
    const src = `"""m"""
revision = "child1"
down_revision = "aaa11111111"`;
    const expected = `"""m"""
revision = "child1"
down_revision = "bbb22222222"`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("13. leading BOM is preserved and the rewrite lands on the right line", () => {
    const src =
      "\ufeff" +
      `"""m"""
revision = "child1"
down_revision = "aaa11111111"
`;
    const expected =
      "\ufeff" +
      `"""m"""
revision = "child1"
down_revision = "bbb22222222"
`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("13b. BOM directly on the assignment line: BOM survives ahead of the preserved left-hand side", () => {
    const src = "\ufeff" + `down_revision = "aaa11111111"\nrevision = "child1"\n`;
    const expected = "\ufeff" + `down_revision = "bbb22222222"\nrevision = "child1"\n`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("14. no down_revision assignment -> error", () => {
    const src = `"""m"""
revision = "child1"
`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result).toEqual({ ok: false, reason: "no down_revision assignment found" });
  });

  it("15. no docstring / no Revises: line: value rewritten, rest untouched", () => {
    const src = `revision = "child1"
down_revision = "aaa11111111"
`;
    const expected = `revision = "child1"
down_revision = "bbb22222222"
`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("16. multiple Revises: lines: only the first one is rewritten", () => {
    const src = `"""merge note

Revises: 18c9d9663f5b

The actual predecessor:
Revises: aaa11111111
"""
revision = "child1"
down_revision = "aaa11111111"
`;
    const expected = `"""merge note

Revises: bbb22222222

The actual predecessor:
Revises: aaa11111111
"""
revision = "child1"
down_revision = "bbb22222222"
`;
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });
  it("17. no docstring Revises: line: a Revises:-looking line inside an upgrade() SQL body is NOT touched", () => {
    const src = `"""add audit log

Revision ID: 5c0d13aa7d9f
Create Date: 2026-05-12 10:12:00.000000

"""
from alembic import op

revision = "5c0d13aa7d9f"
down_revision = "aaa11111111"


def upgrade() -> None:
    op.execute(
        """
        -- quoted verbatim from the ticket:
        Revises: zzz11111111
        """
    )
`;
    // Byte-identical everywhere except the assignment itself: the SQL body must survive intact.
    const expected = src.replace('down_revision = "aaa11111111"', 'down_revision = "bbb22222222"');
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });

  it("18. docstring Revises: present: it is patched and the same SQL decoy below stays untouched", () => {
    const src = `"""add audit log

Revision ID: 5c0d13aa7d9f
Revises: aaa11111111
Create Date: 2026-05-12 10:12:00.000000

"""
from alembic import op

revision = "5c0d13aa7d9f"
down_revision = "aaa11111111"


def upgrade() -> None:
    op.execute(
        """
        Revises: aaa11111111
        """
    )
`;
    const expected = src
      .replace("Revises: aaa11111111", "Revises: bbb22222222")
      .replace('down_revision = "aaa11111111"', 'down_revision = "bbb22222222"');
    const result = computeDownRevisionsRewrite(src, ["bbb22222222"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newSrc).toBe(expected);
  });
});
