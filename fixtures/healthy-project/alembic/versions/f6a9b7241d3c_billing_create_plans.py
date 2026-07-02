"""billing: create plans

Revision ID: f6a9b7241d3c
Revises: d4c7f5309b2e
Create Date: 2026-05-06 10:06:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "f6a9b7241d3c"
down_revision = "d4c7f5309b2e"
branch_labels = ("billing",)
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("interval", sa.String(length=20), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("plans")
