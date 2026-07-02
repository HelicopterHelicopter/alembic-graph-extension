"""merge oauth and billing

Revision ID: 29dae0774a6c
Revises: 18c9d9663f5b, 07b8c8552e4a
Create Date: 2026-05-09 10:09:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "29dae0774a6c"
down_revision: Union[str, Sequence[str], None] = ("18c9d9663f5b", "07b8c8552e4a")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
