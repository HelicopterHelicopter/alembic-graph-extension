"""add oauth provider fields

Revision ID: e5b8a600cc11
Revises: d4c7f5309b2e
Create Date: 2026-05-05 10:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5b8a600cc11'
down_revision: Union[str, Sequence[str], None] = 'd4c7f5309b2e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('oauth_provider', sa.String(length=50), nullable=True))
    op.add_column('users', sa.Column('oauth_id', sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'oauth_id')
    op.drop_column('users', 'oauth_provider')
