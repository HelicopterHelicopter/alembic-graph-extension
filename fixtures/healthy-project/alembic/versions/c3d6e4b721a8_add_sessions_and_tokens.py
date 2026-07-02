"""add sessions and tokens

Revision ID: c3d6e4b721a8
Revises: b2e5d3a10f66
Create Date: 2026-05-03 10:03:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c3d6e4b721a8"
down_revision: Union[str, Sequence[str], None] = "b2e5d3a10f66"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("token", sa.String(length=255), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("tokens")
    op.drop_table("sessions")
