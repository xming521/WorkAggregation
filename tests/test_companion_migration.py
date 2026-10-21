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


def test_v11_adds_user_chat_provenance_without_replacing_v1_state(tmp_path):
    from offerpilot.companion.contracts import CompanionEventCommand
    from offerpilot.companion.models import CompanionState
    from uuid import uuid4

    path = tmp_path / 'old-v1.db'
    sessions = init_database(path)
    repo = CompanionRepository(sessions)
    first = repo.read()
    started = repo.apply_event(CompanionEventCommand(identity=first['identity'], expected_revision=first['revision'],
                                                   command_id=uuid4(), event='app_open'))
    sessions.kw['bind'].dispose()
    with sqlite3.connect(path) as connection:
        connection.execute('DROP TABLE companion_chat_evidence')
        connection.execute('ALTER TABLE companion_participation DROP COLUMN origin')
        connection.execute("UPDATE companion_state SET persona_version='companion-v1'")
        connection.execute("DELETE FROM schema_migrations WHERE version='0035_companion_chat'")
    upgraded = init_database(path)
    restored = CompanionRepository(upgraded).read()
    assert restored['identity'] == first['identity']
    assert restored['state'] == started['state']
    assert restored['revision'] == started['revision'] + 1
    assert restored['persona_version'] == 'companion-v1.1'
    with upgraded() as session:
        assert session.get(CompanionState, 1).identity == first['identity']
    assert CompanionRepository(upgraded).read()['revision'] == restored['revision']
