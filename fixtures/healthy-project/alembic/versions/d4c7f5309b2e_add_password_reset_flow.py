"""add password reset flow

Revision ID: d4c7f5309b2e
Revises: c3d6e4b721a8
Create Date: 2026-05-04 10:04:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd4c7f5309b2e'
down_revision = 'c3d6e4b721a8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'password_resets',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('token', sa.String(length=255), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('password_resets')
