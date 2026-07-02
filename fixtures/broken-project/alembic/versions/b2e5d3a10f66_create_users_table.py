"""create users table

Revision ID: b2e5d3a10f66
Revises: 8f2a1c9d4e07
Create Date: 2026-05-02 10:02:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b2e5d3a10f66"
down_revision = "8f2a1c9d4e07"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("users")
