"""Companion lifecycle correctness, identity fencing and factual separation."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text

from offerpilot.companion.api import register_companion_routes
from offerpilot.companion.contracts import (
    CompanionEventCommand, CompanionPolicy, CompanionPresenceCommand,
    CompanionResetCommand, CompanionSettingsCommand,
)
from offerpilot.companion.models import (
    CompanionCommandReceipt, CompanionEvent, CompanionParticipation, CompanionUsageSession,
)
from offerpilot.companion.repository import (
    CompanionConflict, CompanionRepository, IDLE_COOLDOWN_SECONDS, MIN_STEP_SECONDS,
    companion_client_active, companion_policy, companion_presence, companion_publish_guard,
    companion_source, mark_companion_published,
)
from offerpilot.db import init_database
from offerpilot.models import Application, Conversation, MockInterviewAttempt, PilotExecution, PilotTurnRecord
from offerpilot.proactive.models import ProactiveJob

NOW = datetime(2026, 10, 21, 4, tzinfo=timezone.utc).timestamp()


@pytest.fixture
def life(tmp_path):
    sessions = init_database(tmp_path / "companion.db")
    return sessions, CompanionRepository(sessions)


def fence(repo):
    view = repo.read(NOW)
    return dict(identity=view["identity"], expected_revision=view["revision"], command_id=uuid4())


def event(repo, kind="app_open", now=NOW, **kwargs):
    return repo.apply_event(CompanionEventCommand(**fence(repo), event=kind, **kwargs), now)


def activity_event(repo, kind, now=NOW, **kwargs):
    return event(repo, kind, now, activity_id=repo.read(now)["state"]["activity"]["id"], **kwargs)


def settings(repo, now=NOW, **kwargs):
    return repo.update_settings(CompanionSettingsCommand(**fence(repo), settings=CompanionPolicy(**kwargs)), now)


def present(repo, now=NOW, client_id=None, sequence=0, **flags):
    client_id = client_id or uuid4()
    return repo.presence(CompanionPresenceCommand(identity=repo.read(now)["identity"],
        client_id=client_id, sequence=sequence, **flags), now), str(client_id)


def test_reads_and_heartbeats_do_not_advance_and_restart_continues(life):
    sessions, repo = life
    initial = repo.read(NOW)
    assert initial["state"]["activity"] is None
    present(repo)
    assert repo.read(NOW)["revision"] == initial["revision"]
    started = event(repo)
    rebooted = CompanionRepository(sessions)
    restored = rebooted.read(NOW + 100)
    assert restored["identity"] == started["identity"]
    assert restored["state"] == started["state"]
    assert event(rebooted, now=NOW + 10)["changed"] is False
    assert event(rebooted, now=NOW + MIN_STEP_SECONDS)["state"]["activity"]["step_index"] == 1


def test_day_gap_one_step_no_backlog_and_terminal_has_idle_cooldown(life):
    _, repo = life
    event(repo)
    after_gap = event(repo, now=NOW + 86400 * 30)
    assert after_gap["state"]["activity"]["step_index"] == 1
    assert len(after_gap["recent_events"]) == 2
    assert not event(repo, now=NOW + 86400 * 30 + 1)["changed"]
    now = NOW + 86400 * 30 + 300
    event(repo, now=now)
    done = event(repo, now=now + 300)
    assert done["state"]["activity"]["status"] == "completed"
    assert not event(repo, now=now + 601)["changed"]
    next_activity = event(repo, now=now + 300 + IDLE_COOLDOWN_SECONDS)
    assert next_activity["state"]["activity"]["id"] != done["state"]["activity"]["id"]


def test_exact_idempotent_receipt_is_not_reexecuted_or_rebound(life):
    sessions, repo = life
    command = CompanionEventCommand(**fence(repo), event="app_open")
    first = repo.apply_event(command, NOW)
    later = event(repo, now=NOW + 300)
    assert repo.apply_event(command, NOW + 600) == first
    assert repo.read(NOW)["revision"] == later["revision"]
    with pytest.raises(CompanionConflict, match="command_id_conflict"):
        repo.apply_event(command.model_copy(update={"event": "chat_end"}), NOW + 600)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(CompanionEvent)) == 2


def test_simultaneous_windows_cannot_both_advance(life):
    _, repo = life
    first = event(repo)
    commands = [CompanionEventCommand(identity=first["identity"], expected_revision=first["revision"],
                                     command_id=uuid4(), event="chat_end") for _ in range(2)]
    def run(command):
        try:
            return repo.apply_event(command, NOW + 300)["changed"]
        except CompanionConflict:
            return "conflict"
    with ThreadPoolExecutor(2) as workers:
        results = list(workers.map(run, commands))
    assert sorted(results, key=str) == [True, "conflict"]
    assert repo.read(NOW)["state"]["activity"]["step_index"] == 1


def test_stale_advance_after_pause_fails_and_resume_resets_elapsed(life):
    _, repo = life
    started = event(repo)
    old = CompanionEventCommand(**fence(repo), event="chat_end")
    activity_event(repo, "pause", NOW + 1)
    with pytest.raises(CompanionConflict, match="revision_conflict"):
        repo.apply_event(old, NOW + 500)
    assert not event(repo, now=NOW + 86400)["changed"]
    resumed = activity_event(repo, "resume", NOW + 86400)
    assert resumed["state"]["activity"]["id"] == started["state"]["activity"]["id"]
    assert not event(repo, now=NOW + 86401)["changed"]


def test_shared_step_never_completes_passively_or_claims_user_work(life):
    sessions, repo = life
    event(repo)
    waiting = activity_event(repo, "join", NOW + 1)
    assert waiting["state"]["activity"]["status"] == "waiting_shared"
    for kind in ("app_open", "chat_end", "work_completed", "user_interaction"):
        assert not event(repo, kind, NOW + 86400)["changed"]
    activity_event(repo, "pause", NOW + 86401)
    activity_event(repo, "resume", NOW + 86402)
    assert repo.read(NOW)["state"]["activity"]["status"] == "waiting_shared"
    with sessions() as session:
        participation = session.scalar(select(CompanionParticipation))
        assert participation.status == "promised"
        assert participation.completed_at is None
    completed = activity_event(repo, "complete_shared", NOW + 86403)
    assert completed["shared_participation"][0]["status"] == "completed"
    assert completed["recent_events"][0]["category"] == "actual"
    assert completed["recent_events"][0]["source"] == "user_command"


def test_wish_decline_and_stale_activity_id_cannot_mutate_new_activity(life):
    _, repo = life
    started = event(repo)
    wish = started["state"]["wish"]
    declined = activity_event(repo, "decline_wish", NOW + 1, wish_id=wish["id"])
    assert declined["state"]["wish"] is None
    with pytest.raises(CompanionConflict, match="wish_identity_conflict"):
        activity_event(repo, "accept_wish", NOW + 2, wish_id=wish["id"])
    activity_event(repo, "abandon", NOW + 3)
    newer = event(repo, now=NOW + IDLE_COOLDOWN_SECONDS + 3)
    assert newer["state"]["activity"]["id"] != started["state"]["activity"]["id"]
    with pytest.raises(CompanionConflict, match="activity_identity_conflict"):
        event(repo, "pause", NOW + 3000, activity_id=started["state"]["activity"]["id"])


def test_mode_off_preserves_state_proactivity_off_still_progresses(life):
    _, repo = life
    started = event(repo)
    settings(repo, enabled=False)
    assert not event(repo, now=NOW + 86400)["changed"]
    assert repo.read(NOW)["state"] == started["state"]
    settings(repo, proactivity="off", hide_status=True)
    progressed = event(repo, now=NOW + 86400)
    assert progressed["state"]["activity"]["step_index"] == 1
    assert progressed["state"]["interests"] == ["paper_crafts", "odd_ideas"]


def test_reset_erases_private_history_but_fences_old_commands_and_keeps_unanswered_guard(life):
    sessions, repo = life
    event(repo)
    old_command = CompanionEventCommand(**fence(repo), event="chat_end")
    activity_event(repo, "join")
    with sessions() as session:
        session.get(CompanionUsageSession, 1).unanswered = True
        session.commit()
    command = CompanionResetCommand(**fence(repo), confirmed=True)
    result = repo.reset(command, NOW + 1)
    assert repo.reset(command, NOW + 2) == result
    assert result["identity"] != str(command.identity)
    assert result["state"]["activity"] is None
    assert result["shared_participation"] == result["recent_events"] == []
    with pytest.raises(CompanionConflict, match="identity_conflict"):
        repo.apply_event(old_command, NOW + 5)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(CompanionEvent)) == 0
        assert session.scalar(select(func.count()).select_from(CompanionParticipation)) == 0
        assert session.scalar(select(func.count()).select_from(CompanionCommandReceipt)) == 1
        assert session.get(CompanionUsageSession, 1).unanswered


def test_aggregate_presence_blocks_from_other_window_and_expires(life):
    sessions, repo = life
    event(repo)
    _, first = present(repo)
    present(repo, NOW + 1, typing=True, visible=False)
    with sessions() as session:
        assert companion_client_active(session, first, NOW + 2)
        assert companion_presence(session, NOW + 2)["blockers"] == ["typing"]
        assert not companion_publish_guard(session, NOW + 2)
    present(repo, NOW + 61, client_id=first, sequence=1)
    with sessions() as session:
        assert companion_publish_guard(session, NOW + 62)
        assert not companion_client_active(session, first, NOW + 122)
        assert not companion_publish_guard(session, NOW + 122)


def test_unanswered_session_suppression_only_explicit_interaction_acknowledges(life):
    sessions, repo = life
    event(repo)
    present(repo)
    with sessions() as session:
        session.execute(text("BEGIN IMMEDIATE"))
        source = companion_source(session)
        assert companion_publish_guard(session, NOW + 1)
        assert mark_companion_published(session, NOW + 1, source[1]["event_id"])
        session.commit()
    for kind in ("app_open", "chat_end", "work_completed"):
        event(repo, kind, NOW + 2)
        with sessions() as session:
            assert not companion_publish_guard(session, NOW + 3)
    event(repo, "user_interaction", NOW + 3)
    with sessions() as session:
        assert companion_publish_guard(session, NOW + 4)


def _published_job(at):
    key = str(uuid4())
    return ProactiveJob(id=key, idempotency_key=key, kind="companion_life", application_id=0,
        source_digest="x", state="succeeded", reason="virtual", due_at=at, expires_at=at + 3600,
        created_at=at, published_at=at)


def test_publish_budget_rolling_and_local_day_survives_reset(life):
    sessions, repo = life
    event(repo)
    present(repo)
    with sessions() as session:
        session.add_all([_published_job(NOW - 7200), _published_job(NOW - 3700)])
        session.commit()
        assert not companion_publish_guard(session, NOW)
    repo.reset(CompanionResetCommand(**fence(repo), confirmed=True), NOW)
    event(repo)
    present(repo)
    with sessions() as session:
        assert not companion_publish_guard(session, NOW)
        assert session.scalar(select(func.count()).select_from(ProactiveJob)) == 2


@pytest.mark.parametrize("kind", ["pending", "running", "mock"])
def test_backend_business_truth_blocks_even_if_browser_reports_idle(life, kind):
    sessions, repo = life
    event(repo)
    present(repo)
    with sessions() as session:
        if kind in ("pending", "running"):
            conversation = Conversation(title="synthetic", pending_tool_name="save_note" if kind == "pending" else "")
            session.add(conversation)
            session.flush()
            if kind == "running":
                turn = PilotTurnRecord(id=str(uuid4()), conversation_id=conversation.id)
                session.add(turn)
                session.flush()
                session.add(PilotExecution(turn_id=turn.id, generation=1, conversation_id=conversation.id,
                    owner_token="test", state="running", renewed_at_ms=1, lease_until_ms=2))
        else:
            session.add(MockInterviewAttempt(application_id=1, event_id=1, resume_id=1,
                idempotency_key="test", input_snapshot_json="{}", source_fingerprint="test",
                attempt_status="awaiting_answer", transcript_fingerprint="test"))
        session.commit()
        assert not companion_publish_guard(session, NOW)


def test_life_commands_do_not_mutate_business_memory_or_queue(life):
    sessions, repo = life
    with sessions() as session:
        app = Application(company_name="不应改变", position_name="测试职位")
        session.add(app)
        session.commit()
        app_id = app.id
        before = {name: session.scalar(text(f'SELECT COUNT(*) FROM "{name}"'))
                  for name in ("applications", "application_events", "confirmed_memories", "proactive_jobs")}
    event(repo)
    activity_event(repo, "join")
    activity_event(repo, "complete_shared")
    settings(repo, proactivity="off")
    with sessions() as session:
        after = {name: session.scalar(text(f'SELECT COUNT(*) FROM "{name}"')) for name in before}
        assert before == after
        assert session.get(Application, app_id).company_name == "不应改变"
        assert companion_policy(session)[1].proactivity == "off"


def test_api_shapes_conflicts_validation_and_postcommit_queue_failure(life):
    sessions, _ = life
    app = FastAPI()
    def failed_queue():
        raise RuntimeError("simulated schedule failure")
    register_companion_routes(app, sessions, failed_queue)
    with TestClient(app) as client:
        original = client.get("/api/companion").json()
        body = dict(identity=original["identity"], expected_revision=original["revision"],
                    command_id=str(uuid4()), event="app_open")
        result = client.post("/api/companion/events", json=body)
        assert result.status_code == 200
        assert result.json()["state"]["activity"]
        assert client.post("/api/companion/events", json=body).json() == result.json()
        assert client.post("/api/companion/events", json={**body, "command_id": str(uuid4())}).status_code == 409
        assert client.post("/api/companion/events", json={**body, "arbitrary_state": {}}).status_code == 422
        assert client.delete("/api/companion").status_code == 422


def test_reset_sanitizes_queue_prose_without_erasing_budget(life):
    sessions, repo = life
    event(repo)
    with sessions() as session:
        published = _published_job(NOW - 10)
        published.result_text = "虚拟日常中应该删除的旧故事"
        pending = _published_job(NOW)
        pending.state, pending.published_at, pending.result_text = "running", None, "旧草稿"
        business = _published_job(NOW)
        business.kind, business.result_text = "deadline", "业务提醒不应改变"
        session.add_all([published, pending, business])
        session.commit()
        ids = published.id, pending.id, business.id
    repo.reset(CompanionResetCommand(**fence(repo), confirmed=True), NOW)
    with sessions() as session:
        published, pending, business = [session.get(ProactiveJob, key) for key in ids]
        assert published.result_text == pending.result_text == ""
        assert published.published_at == NOW - 10
        assert pending.state == "cancelled"
        assert business.result_text == "业务提醒不应改变"


def test_reordered_idle_heartbeat_never_clears_typing_or_revives_expired_client(life):
    sessions, repo = life
    event(repo)
    _, client = present(repo, NOW, sequence=2, typing=True)
    # A second visible window cannot bypass the first window's typing blocker.
    _, other = present(repo, NOW + 1)
    delayed = CompanionPresenceCommand(identity=repo.read(NOW)["identity"],
        client_id=client, sequence=1, visible=True, typing=False)
    result = repo.presence(delayed, NOW + 2)
    assert result["blockers"] == ["typing"]
    with sessions() as session:
        assert companion_client_active(session, other, NOW + 2)
        assert not companion_publish_guard(session, NOW + 2)
    # Expiry must not erase the sequence fence or refresh visibility on replay.
    expired = repo.presence(delayed, NOW + 100)
    assert not expired["active"]
    assert expired["blockers"] == ["offline"]
    with sessions() as session:
        assert not companion_client_active(session, client, NOW + 100)
        assert not companion_publish_guard(session, NOW + 100)


def test_presence_equal_sequence_replays_without_ttl_refresh_and_rejects_rebinding(life):
    sessions, repo = life
    _, client = present(repo, sequence=7, typing=True)
    same = CompanionPresenceCommand(identity=repo.read(NOW)["identity"],
        client_id=client, sequence=7, typing=True)
    assert repo.presence(same, NOW + 59)["active"]
    assert not repo.presence(same, NOW + 61)["active"]
    with pytest.raises(CompanionConflict, match="presence_sequence_conflict"):
        repo.presence(same.model_copy(update={"typing": False}), NOW + 62)
    # A strictly newer sequence can clear typing and establish new visibility.
    present(repo, NOW + 63, client_id=client, sequence=8)
    with sessions() as session:
        assert companion_presence(session, NOW + 64)["blockers"] == []


def test_session_quiet_survives_refresh_and_initiating_window_expiry(life):
    sessions, repo = life
    event(repo)
    _, first = present(repo)
    command = CompanionEventCommand(**fence(repo), event="quiet_session")
    quiet = repo.apply_event(command, NOW + 1)
    assert quiet["presence"]["session_quiet"]
    assert repo.apply_event(command, NOW + 2) == quiet
    restarted = CompanionRepository(sessions)
    _, second = present(restarted, NOW + 2)
    assert restarted.read(NOW + 2)["presence"]["session_quiet"]
    present(repo, NOW + 3, client_id=first, sequence=1, visible=False)
    # B remains visible beyond A's presence expiry. Its quiet=false heartbeat
    # cannot lift the shared usage-session choice.
    present(repo, NOW + 65, client_id=second, sequence=1, quiet=False)
    with sessions() as session:
        assert not companion_client_active(session, first, NOW + 65)
        assert companion_client_active(session, second, NOW + 65)
        assert companion_presence(session, NOW + 65)["blockers"] == ["quiet"]
        assert not companion_publish_guard(session, NOW + 65)


def test_quiet_reset_preserves_session_choice_new_session_alone_clears_it(life):
    sessions, repo = life
    _, client = present(repo)
    event(repo, "quiet_session", NOW + 1)
    with sessions() as session:
        session.get(CompanionUsageSession, 1).unanswered = True
        session.commit()
    before = repo.read(NOW + 2)["presence"]
    repo.reset(CompanionResetCommand(**fence(repo), confirmed=True), NOW + 2)
    after = repo.read(NOW + 3)["presence"]
    assert after["session_quiet"] and after["unanswered"]
    assert after["session_id"] == before["session_id"]
    present(repo, NOW + 4, client_id=client, sequence=1)
    assert repo.read(NOW + 4)["presence"]["session_quiet"]
    # Silence alone does not mutate reads. A genuinely new visible session does.
    assert repo.read(NOW + 1804)["presence"]["session_quiet"]
    present(repo, NOW + 1804, client_id=client, sequence=2)
    current = repo.read(NOW + 1804)["presence"]
    assert current["session_id"] != before["session_id"]
    assert not current["session_quiet"] and not current["unanswered"]


def test_session_controls_work_without_activity_or_enabled_mode_and_never_ack(life):
    sessions, repo = life
    settings(repo, enabled=False)
    with sessions() as session:
        session.get(CompanionUsageSession, 1).unanswered = True
        session.commit()
    quiet = event(repo, "quiet_session", NOW + 1)
    assert quiet["state"]["activity"] is None
    assert quiet["recent_events"] == []
    assert quiet["presence"]["session_quiet"] and quiet["presence"]["unanswered"]
    # Even the first ever heartbeat cannot immediately erase an explicit choice.
    present(repo, NOW + 2)
    assert repo.read(NOW + 2)["presence"]["session_quiet"]
    resumed = event(repo, "resume_session", NOW + 3)
    assert not resumed["presence"]["session_quiet"]
    assert resumed["presence"]["unanswered"]
    assert resumed["revision"] == quiet["revision"] + 1
    assert resumed["state"] == quiet["state"]


def test_quiet_command_fences_concurrent_advance(life):
    _, repo = life
    started = event(repo)
    commands = [CompanionEventCommand(identity=started["identity"], expected_revision=started["revision"],
        command_id=uuid4(), event=kind) for kind in ("quiet_session", "chat_end")]
    def run(command):
        try:
            return repo.apply_event(command, NOW + 300)["changed"]
        except CompanionConflict:
            return "conflict"
    with ThreadPoolExecutor(2) as workers:
        outcomes = list(workers.map(run, commands))
    assert sorted(outcomes, key=str) == [True, "conflict"]
    assert repo.read(NOW + 300)["revision"] == started["revision"] + 1
