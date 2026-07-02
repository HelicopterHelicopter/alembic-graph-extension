"""add rate limiting

Revision ID: 3aebf1885b7d
Revises: 29dae0774a6c
Create Date: 2026-05-10 10:10:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "3aebf1885b7d"
down_revision = "29dae0774a6c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rate_limits",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("endpoint", sa.String(length=100), nullable=False),
        sa.Column("window_start", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("rate_limits")
