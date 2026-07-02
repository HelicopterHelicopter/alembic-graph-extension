"""billing: add invoices

Revision ID: 07b8c8552e4a
Revises: f6a9b7241d3c
Create Date: 2026-05-08 10:08:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '07b8c8552e4a'
down_revision = 'f6a9b7241d3c'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'invoices',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('plan_id', sa.Integer(), nullable=False),
        sa.Column('amount_cents', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('invoices')
