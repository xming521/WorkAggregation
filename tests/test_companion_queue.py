"""Companion delivery uses the existing durable publication boundary."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import select

from offerpilot.companion.contracts import CompanionEventCommand, CompanionPresenceCommand
from offerpilot.companion.repository import CompanionRepository
from offerpilot.companion.models import CompanionPresence
from offerpilot.db import init_database
from offerpilot.proactive.models import ProactiveJob
from offerpilot.proactive.repository import ProactiveRepository

NOW = datetime(2026, 10, 21, 4, tzinfo=timezone.utc).timestamp()


def event(repo, name, now=NOW, **extra):
    view = repo.read(now)
    return repo.apply_event(CompanionEventCommand(
        identity=view['identity'], expected_revision=view['revision'], command_id=uuid4(),
        event=name, **extra,
    ), now)


def presence(repo, client, now=NOW, **flags):
    view = repo.read(now)
    with repo.sessions() as session:
        row = session.get(CompanionPresence, client)
        sequence = row.last_sequence + 1 if row else 0
    return repo.presence(CompanionPresenceCommand(
        identity=view['identity'], client_id=client, sequence=sequence, **flags,
    ), now)


@pytest.fixture
def life(tmp_path):
    sessions = init_database(tmp_path / 'life.db')
    repo = CompanionRepository(sessions)
    client = str(uuid4())
    view = event(repo, 'app_open')
    presence(repo, client)
    return sessions, repo, ProactiveRepository(sessions), client, view


def test_two_windows_deliver_once_and_response_retry_never_replays(life):
    sessions, repo, queue, client, view = life
    client2 = str(uuid4())
    presence(repo, client2)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda cid: queue.take_companion_bid(
            view['identity'], view['revision'], cid, NOW,
        ), [client, client2]))
    assert sum(item is not None for item in results) == 1
    assert queue.take_companion_bid(view['identity'], view['revision'], client, NOW + 1) is None
    assert repo.read(NOW)['revision'] == view['revision']
    assert queue.list_jobs() == []  # No virtual story in the job inbox.
    with sessions() as session:
        rows = session.scalars(select(ProactiveJob)).all()
        assert len(rows) == 1 and rows[0].state == 'succeeded'


def test_scheduler_cannot_dispatch_life_and_state_does_not_depend_on_delivery(life):
    _, repo, queue, client, view = life
    assert queue.discover_companion(NOW) == 1
    assert queue.claim('background', NOW) is None
    assert queue.discover_companion(NOW) == 0
    assert repo.read(NOW)['state'] == view['state']
    job_id = queue.claim('worker', NOW, companion_only=True)
    job = queue.begin(job_id, 'worker', NOW)
    assert job is not None
    queue.fail(job_id, 'worker', unknown=False)
    assert queue.take_companion_bid(view['identity'], view['revision'], client, NOW + 1) is None
    assert repo.read(NOW)['state'] == view['state']


@pytest.mark.parametrize('change', ['pause', 'typing', 'quiet', 'failure', 'work_running', 'awaiting_approval', 'mock_interview'])
def test_publish_rechecks_source_and_suppression(life, change):
    sessions, repo, queue, client, view = life
    queue.discover_companion(NOW)
    job_id = queue.claim('worker', NOW, companion_only=True)
    job = queue.begin(job_id, 'worker', NOW)
    assert job is not None
    if change == 'pause':
        event(repo, 'pause', NOW + 1, activity_id=view['state']['activity']['id'])
    else:
        presence(repo, client, NOW + 1, **{change: True})
    assert not queue.publish(job_id, 'worker', job['turn_id'], job['execution_generation'], 'unsafe model text', NOW + 1, delivery_client_id=client)
    with sessions() as session:
        row = session.get(ProactiveJob, job_id)
        assert row.result_text == '' and row.published_at is None


def test_deterministic_source_text_only_and_stale_request_is_silent(life):
    sessions, repo, queue, client, view = life
    assert queue.take_companion_bid(view['identity'], view['revision'] - 1, client, NOW) is None
    assert queue.take_companion_bid(view['identity'], view['revision'], str(uuid4()), NOW) is None
    queue.discover_companion(NOW)
    job_id = queue.claim('worker', NOW, companion_only=True)
    job = queue.begin(job_id, 'worker', NOW)
    assert queue.publish(job_id, 'worker', job['turn_id'], job['execution_generation'], 'I watched a real video', NOW, delivery_client_id=client)
    with sessions() as session:
        assert session.get(ProactiveJob, job_id).result_text == job['source']['text']
    assert not queue.publish(job_id, 'worker', job['turn_id'], job['execution_generation'], 'again', NOW, delivery_client_id=client)


def test_inactive_or_expired_candidate_never_delivers(life):
    _, repo, queue, client, view = life
    presence(repo, client, NOW + 1, visible=False)
    assert queue.take_companion_bid(view['identity'], view['revision'], client, NOW + 1) is None
    presence(repo, client, NOW + 3601)
    assert queue.take_companion_bid(view['identity'], view['revision'], client, NOW + 3601) is None
    assert repo.read(NOW + 3601)['revision'] == view['revision']


def test_missing_usage_fails_closed_instead_of_publishing_without_session_guard(life):
    from offerpilot.companion.models import CompanionUsageSession

    sessions, _, queue, client, _ = life
    queue.discover_companion(NOW)
    job_id = queue.claim('worker', NOW, companion_only=True)
    job = queue.begin(job_id, 'worker', NOW)
    with sessions() as session:
        session.delete(session.get(CompanionUsageSession, 1))
        session.commit()
    assert not queue.publish(job_id, 'worker', job['turn_id'], job['execution_generation'],
                             job['source']['text'], NOW, delivery_client_id=client)
