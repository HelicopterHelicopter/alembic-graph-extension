"""create products table

Revision ID: 8f2a1c9d4e07
Revises:
Create Date: 2026-05-01 10:01:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8f2a1c9d4e07'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'products',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('price', sa.Numeric(10, 2), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('products')
