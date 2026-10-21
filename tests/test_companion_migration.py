"""Additive initialization preserves pre-companion business records."""
import sqlite3

from sqlalchemy import select

from offerpilot.companion.repository import CompanionRepository
from offerpilot.db import init_database
from offerpilot.models import Application

TABLES = (
    'companion_state', 'companion_events', 'companion_participation',
    'companion_command_receipts', 'companion_presence', 'companion_usage_session',
)


def test_old_database_upgrade_is_additive_and_restart_preserves_identity(tmp_path):
    path = tmp_path / 'data.db'
    sessions = init_database(path)
    with sessions() as session:
        session.add(Application(company_name='Keep company', position_name='Keep job'))
        session.commit()
    sessions.kw['bind'].dispose()
    # Model the previous schema, which had no companion tables or migration.
    with sqlite3.connect(path) as connection:
        for table in TABLES:
            connection.execute(f'DROP TABLE {table}')
        connection.execute("DELETE FROM schema_migrations WHERE version='0034_companion_life'")
    upgraded = init_database(path)
    first = CompanionRepository(upgraded).read()
    with upgraded() as session:
        row = session.scalar(select(Application))
        assert row.company_name == 'Keep company'
        assert row.position_name == 'Keep job'
    upgraded.kw['bind'].dispose()
    restarted = init_database(path)
    assert CompanionRepository(restarted).read()['identity'] == first['identity']
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT 1 FROM schema_migrations WHERE version='0034_companion_life'").fetchone()
        for table in TABLES:
            assert connection.execute(f'PRAGMA foreign_key_list({table})').fetchall() == []
