"""search index (experimental)

Revision ID: 4bfc02996c8e
Revises: 29dae0774a6c
Create Date: 2026-05-11 10:11:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4bfc02996c8e'
down_revision: Union[str, Sequence[str], None] = '29dae0774a6c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index('ix_products_name', 'products', ['name'])


def downgrade() -> None:
    op.drop_index('ix_products_name', table_name='products')
