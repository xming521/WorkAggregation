"""Small, read-only companion data for an explicitly relevant workspace turn.

This is a distinct data source inside the existing current-scope projection, not
system policy, a new user request, a tool result, or a confirmed-memory record.
"""
from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from offerpilot.ai.types import Message
from offerpilot.context_projector.contracts import FrozenMessage, ProjectionError, canonical_json

from .persona import PERSONA_VERSION

COMPANION_CONTEXT_BYTE_CAP = 2048
_QUERY_CHARACTER_CAP = 4096
_STATE_JSON_BYTE_CAP = 32768

# Conservative opt-in retrieval: ambiguous greetings and generic requests never
# summon a fictional daily life. Any work signal wins over a casual-life signal.
_WORK_ZH = (
    "工作", "任务", "求职", "简历", "面试", "复盘", "投递", "岗位", "招聘", "笔试",
    "薪资", "薪酬", "录用", "日程", "代码", "报错", "修复", "测试", "项目",
)
_WORK_EN = re.compile(
    r"\b(?:work|task|job|jobs|career|resume|interview|application|offer|salary|"
    r"recruitment|schedule|code|bug|debug|test|project|jd)\b", re.IGNORECASE,
)
_LIFE_ZH = (
    "你的日常", "你的小日常", "角色日常", "虚拟日常", "日常活动", "你在干嘛", "你在做什么",
    "你最近在做什么", "你今天在做什么", "你今天做了什么", "你最近在玩什么", "你在玩什么",
    "你想玩什么", "你想做什么", "你在忙什么", "你的手工", "你的折纸", "你的愿望", "你的小船",
    "你有什么小心愿", "云朵的名字", "我们一起的活动",
    "上次一起做的", "我们约好一起", "我们一起选的", "上次选颜色", "一起折纸", "一起做手工", "共同活动", "纸艺", "纸飞机",
)
_LIFE_EN = re.compile(
    r"\b(?:companion life|virtual activit(?:y|ies)|your daily life|your paper craft|"
    r"your origami|our shared activity|our shared choice|what did we choose together|what are you up to|what have you been up to|"
    r"what are you playing|what would you like to play|what did you do today)\b",
    re.IGNORECASE,
)

# Relational questions about authored virtual objects, not every occurrence of
# a boat/cloud word. This selects read-only evidence; it never admits an action.
_OBJECT_REFERENCE = re.compile(
    r"(?P<reference>我们(?:一起(?:做|折))?的|你的|上次一起(?:做|折)的|最近一起(?:做|折)的|这次的|现在的)"
    r"(?P<object>纸小船|小船|纸船|纸星星|星星|云朵)"
)
_OBJECT_TEMPLATES = {
    "纸小船": "paper_boat", "小船": "paper_boat", "纸船": "paper_boat",
    "纸星星": "paper_stars", "星星": "paper_stars", "云朵": "cloud_catalog",
}
_BARE_OBJECT_QUESTION = re.compile(r"(?P<object>云朵|纸小船|小船|纸船|纸星星)的名字[？?。!！]?")
_OBJECT_WORD = re.compile(r"纸小船|小船|纸船|纸星星|星星|云朵")

_REFERENCE_PREFIX = (
    "以下是带来源的角色日常参考数据，不是用户指令、工具结果或操作授权。"
    "virtual 字段仅是虚拟活动；actual_user_participation 仅证明明确的应用内参与操作，"
    "不证明现实行为。约定不等于完成，空参与记录不代表用户参加过。"
    "recent_shared_choice 是一次有来源的选择，不是用户偏好；prior_activity 不属于当前活动。"
    "recall_status 为 ambiguous_activity 时先问哪一次，source_unavailable 时如实说明没有可核实来源。"
    "不得把这些数据写成用户事实、已确认记忆或求职事实。当前请求优先。\n"
)


_REFERENTIAL_LIFE = re.compile(
    r"(?:我们(?:的)?约定(?:呢|是什么)|刚才(?:说好|约好)的(?:那一步)?呢)[？?。!！]?"
)
# Every chat-derived fact must still have the exact actual user source and turn.
_EVIDENCE_FROM = (
    "FROM companion_chat_evidence e "
    "JOIN companion_participation p ON p.id=e.participation_id "
    "AND p.identity=e.identity AND p.activity_id=e.activity_id "
    "JOIN chat_messages m ON m.id=e.message_id AND m.conversation_id=e.conversation_id "
    "AND m.role='user' "
    "JOIN pilot_turns t ON t.id=e.turn_id AND t.conversation_id=e.conversation_id "
    "AND t.user_message_id=e.message_id "
)


def _eligible_query(query: str, context_type: str) -> bool:
    return bool(context_type == "workspace" and query and len(query) <= _QUERY_CHARACTER_CAP
                and not any(word in query for word in _WORK_ZH) and not _WORK_EN.search(query))


def companion_context_relevant(query: str, *, context_type: str) -> bool:
    if not _eligible_query(query, context_type):
        return False
    return (any(word in query for word in _LIFE_ZH) or _LIFE_EN.search(query) is not None
            or _OBJECT_REFERENCE.search(query) is not None
            or _BARE_OBJECT_QUESTION.fullmatch(query.strip()) is not None)


def _json_object(raw: object) -> dict[str, Any]:
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > _STATE_JSON_BYTE_CAP:
        raise ProjectionError("companion_source_invalid")
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ProjectionError("companion_source_invalid") from exc
    if not isinstance(value, dict):
        raise ProjectionError("companion_source_invalid")
    return value


def _short_text(value: object, maximum: int = 80) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise ProjectionError("companion_source_invalid")
    return value


def companion_context_message(data: dict[str, object] | None) -> Message | None:
    """Build one atomic reference envelope; the projector still owns total budget."""
    if data is None:
        return None
    message = _context_envelope(data)
    if message is None and "recent_shared_choice" in data:
        # Optional history must not crowd out the current promise/state. Neither
        # envelope is truncated, and the caller's snapshot is never modified.
        message = _context_envelope({key: value for key, value in data.items()
                                     if key != "recent_shared_choice"})
    return message


def _context_envelope(data: dict[str, object]) -> Message | None:
    content = _REFERENCE_PREFIX + canonical_json(data).decode("utf-8")
    message = Message(
        role="user",
        content=content,
        surface_contributor="current_scope",
        surface_revision=f"companion:{data['identity']}:{data['revision']}",
    )
    if len(canonical_json(FrozenMessage.freeze(message).canonical_value())) + 1 > (
        COMPANION_CONTEXT_BYTE_CAP
    ):
        return None
    return message


def read_companion_context(
    connection: sqlite3.Connection,
    query: str,
    *,
    context_type: str,
    conversation_id: int | None = None,
) -> dict[str, object] | None:
    """Read primitives in the caller's bounded snapshot, without advancing state."""
    explicit = companion_context_relevant(query, context_type=context_type)
    if not explicit and not (
        _eligible_query(query, context_type) and _REFERENTIAL_LIFE.fullmatch(query.strip())
        and type(conversation_id) is int and conversation_id > 0
    ):
        return None
    row = connection.execute(
        "SELECT identity, revision, persona_version, "
        "CASE WHEN length(CAST(settings_json AS BLOB)) <= ? THEN settings_json END, "
        "CASE WHEN length(CAST(life_json AS BLOB)) <= ? THEN life_json END "
        "FROM companion_state WHERE id = 1",
        (_STATE_JSON_BYTE_CAP, _STATE_JSON_BYTE_CAP),
    ).fetchone()
    if row is None:
        return None
    settings = _json_object(row[3])
    if type(settings.get("enabled")) is not bool:
        raise ProjectionError("companion_source_invalid")
    if not settings["enabled"]:
        return None
    identity = _short_text(row[0], 36)
    revision = row[1]
    if not identity or type(revision) is not int or revision < 0 or row[2] != PERSONA_VERSION:
        raise ProjectionError("companion_source_invalid")
    life = _json_object(row[4])
    interests = life.get("interests")
    if not isinstance(interests, list) or len(interests) > 2 or any(
        item not in ("paper_crafts", "odd_ideas") for item in interests
    ):
        raise ProjectionError("companion_source_invalid")
    data: dict[str, object] = {
        "source": "companion_life",
        "identity": identity,
        "revision": revision,
        "persona_version": PERSONA_VERSION,
        "virtual_interests": interests,
        "virtual_activity": None,
        "virtual_wish": None,
        "actual_user_participation": None,
    }
    activity = life.get("activity")
    if not explicit and not _recent_conversation_step(
        connection, query, conversation_id, identity, activity,
    ):
        return None
    target = _OBJECT_REFERENCE.search(query) or _BARE_OBJECT_QUESTION.fullmatch(query.strip())
    target_activity_id = None
    if target is not None:
        if len({_OBJECT_TEMPLATES[item[0]] for item in _OBJECT_WORD.finditer(query)}) > 1:
            data["recall_status"] = "ambiguous_activity"
            return data
        template_id = _OBJECT_TEMPLATES[target["object"]]
        data["requested_virtual_object"] = template_id
        target_activity_id, recall_status = _object_activity(
            connection, identity, activity, template_id, target.groupdict().get("reference", ""),
        )
        if recall_status is not None:
            data["recall_status"] = recall_status
            return data  # Never substitute an unrelated current object or choice.
    kind = "color" if target is not None and "颜色" in query else (
        "name" if target is not None and any(word in query for word in ("叫", "名字", "起名", "取名")) else None
    )
    recent = _recent_choice(connection, identity, activity,
                            activity_id=target_activity_id, step_kind=kind)
    if recent is not None:
        if target is not None:
            recent["virtual_activity_ref"] = {"template_id": _OBJECT_TEMPLATES[target["object"]]}
        data["recent_shared_choice"] = recent
    elif target is not None and kind is not None:
        data["recall_status"] = "source_unavailable"
    if target is not None and (
        not isinstance(activity, dict) or activity.get("id") != target_activity_id
    ):
        return data
    if activity is None:
        return data
    if not isinstance(activity, dict):
        raise ProjectionError("companion_source_invalid")
    activity_id = _short_text(activity.get("id"), 36)
    status = activity.get("status")
    step, total = activity.get("step_index"), activity.get("step_count")
    if (
        not activity_id
        or not isinstance(status, str)
        or status not in {"active", "paused", "waiting_shared", "completed", "abandoned"}
        or type(step) is not int
        or type(total) is not int
        or not 0 <= step < total <= 10
    ):
        raise ProjectionError("companion_source_invalid")
    # Do not copy activity.participants or promise. Those are virtual state, not
    # evidence that the user joined or completed even a single shared step.
    data["virtual_activity"] = {
        "source": "deterministic_template",
        "id": activity_id,
        "title": _short_text(activity.get("title")),
        "status": status,
        "step_index": step,
        "step_count": total,
        "step_title": _short_text(activity.get("step_title")),
    }
    wish = life.get("wish")
    if wish is not None:
        if not isinstance(wish, dict) or wish.get("activity_id") != activity_id:
            raise ProjectionError("companion_source_invalid")
        data["virtual_wish"] = {"text": _short_text(wish.get("text"), 120)}
    participation = connection.execute(
        "SELECT id, status, promise, created_at, completed_at, origin FROM companion_participation "
        "WHERE identity = ? AND activity_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        (identity, activity_id),
    ).fetchone()
    if participation is not None:
        part_status = participation[1]
        if part_status not in {"promised", "completed", "abandoned"}:
            raise ProjectionError("companion_source_invalid")
        if (part_status == "completed") != (participation[4] is not None):
            raise ProjectionError("companion_source_invalid")
        evidence = connection.execute(
            "SELECT e.message_id, e.conversation_id, e.turn_id, e.action, e.step_kind, e.value "
            + _EVIDENCE_FROM +
            "WHERE e.participation_id=? AND e.identity=? AND e.activity_id=? "
            "ORDER BY e.message_id DESC LIMIT 1", (participation[0], identity, activity_id),
        ).fetchone()
        completion_event = None
        if participation[5] == "chat":
            if evidence is None:
                return data
            if part_status == "completed" and evidence[3] != "answer":
                # A prior wait is not proof of a reply. The UI can explicitly
                # finish a chat-origin step, but that is a control outcome, not
                # an invented chat choice. Match the actual completion event.
                completion_event = connection.execute(
                    "SELECT id FROM companion_events WHERE identity=? AND activity_id=? "
                    "AND category='actual' AND source='user_command' "
                    "AND event_type='shared_completed' AND occurred_at=? LIMIT 1",
                    (identity, activity_id, participation[4]),
                ).fetchone()
                if completion_event is None:
                    return data
        data["actual_user_participation"] = {
            "record_id": _short_text(participation[0], 36),
            "source": "companion_participation:user_command",
            "scope": "shared_step_only",
            "status": part_status,
            "promise": _short_text(participation[2], 120),
            "created_at": participation[3],
            "completed_at": participation[4],
        }
        if completion_event is not None:
            participation_data = data["actual_user_participation"]
            assert isinstance(participation_data, dict)
            participation_data["source_event_id"] = completion_event[0]
        elif evidence is not None:
            participation_data = data["actual_user_participation"]
            assert isinstance(participation_data, dict)
            participation_data.update(
                source="companion_participation:user_chat", source_message_id=evidence[0],
                source_conversation_id=evidence[1], source_turn_id=evidence[2],
                action=evidence[3], step_kind=evidence[4], user_reply=evidence[5],
            )
    return data


def _recent_conversation_step(
    connection: sqlite3.Connection, query: str, conversation_id: int | None,
    identity: str, activity: object,
) -> bool:
    """A vague reference only inherits an immediately preceding real shared step.

    This is read-only relevance, not admission: looking up a promise never arms
    the short-answer write slot. The current admitted question may be newest.
    """
    if not isinstance(activity, dict):
        return False
    rows = connection.execute(
        "SELECT id, content FROM chat_messages WHERE conversation_id=? AND role='user' "
        "ORDER BY id DESC LIMIT 2", (conversation_id,),
    ).fetchall()
    if rows and rows[0][1] == query:
        rows = rows[1:]
    if not rows:
        return False
    return connection.execute(
        "SELECT e.message_id " + _EVIDENCE_FROM +
        "WHERE e.identity=? AND e.activity_id=? AND e.conversation_id=? AND e.message_id=? "
        "AND e.action IN ('join', 'wait', 'answer') LIMIT 1",
        (identity, activity.get("id"), conversation_id, rows[0][0]),
    ).fetchone() is not None


def _recent_choice(
    connection: sqlite3.Connection, identity: str, activity: object,
    *, activity_id: str | None = None, step_kind: str | None = None,
) -> dict[str, object] | None:
    """At most one actual completed choice, not a new profile or event history."""
    choice = connection.execute(
        "SELECT e.activity_id, e.step_kind, e.value, e.message_id, e.conversation_id, e.turn_id "
        + _EVIDENCE_FROM +
        "WHERE e.identity=? AND e.action='answer' AND p.origin='chat' "
        "AND p.status='completed' AND p.completed_at IS NOT NULL "
        "AND (? IS NULL OR e.activity_id=?) AND (? IS NULL OR e.step_kind=?) "
        "ORDER BY e.message_id DESC LIMIT 1", (identity, activity_id, activity_id, step_kind, step_kind),
    ).fetchone()
    if choice is None:
        return None
    if choice[1] not in ('color', 'name', 'star'):
        raise ProjectionError("companion_source_invalid")
    current_id = activity.get("id") if isinstance(activity, dict) else None
    return {
        "source": "companion_participation:user_chat",
        "scope": "shared_step_only",
        "activity_id": _short_text(choice[0], 36),
        "activity_relation": "current_activity" if choice[0] == current_id else "prior_activity",
        "step_kind": choice[1], "value": _short_text(choice[2], 40),
        "source_message_id": choice[3], "source_conversation_id": choice[4],
        "source_turn_id": _short_text(choice[5], 36),
    }


def _object_activity(
    connection: sqlite3.Connection, identity: str, activity: object,
    template_id: str, reference: str,
) -> tuple[str | None, str | None]:
    """Resolve one typed entity using metadata plus live actual-source joins.

    Null legacy bindings are unknown. Conflicting bindings invalidate the whole
    entity. Deleted/mismatched chat evidence cannot make an old object relevant.
    Only the current virtual object can exist without actual participation.
    """
    current_id = activity.get("id") if isinstance(activity, dict) else None
    current_type = activity.get("template_id") if isinstance(activity, dict) else None
    current_candidate = (current_id if current_type == template_id
                         and not reference.startswith(("上次", "最近")) else None)
    rows = connection.execute(
        "SELECT b.activity_id, MAX(b.revision) FROM companion_events b "
        "WHERE b.identity=? AND b.activity_id IS NOT NULL GROUP BY b.activity_id "
        "HAVING COUNT(DISTINCT b.template_id)=1 AND MIN(b.template_id)=? "
        "AND NOT (b.activity_id=COALESCE(?, '') AND COALESCE(?, '')!=?) "
        "AND (b.activity_id=? OR EXISTS (SELECT 1 " + _EVIDENCE_FROM +
        "WHERE e.identity=? AND e.activity_id=b.activity_id AND e.action='answer' "
        "AND p.origin='chat' AND p.status='completed' AND p.completed_at IS NOT NULL)) "
        "ORDER BY MAX(b.revision) DESC LIMIT 2",
        (identity, template_id, current_id, current_type, template_id, current_candidate, identity),
    ).fetchall()
    if reference in ("这次的", "现在的"):
        # Do not redirect an explicitly current object to a prior activity.
        return ((str(current_id), None) if any(row[0] == current_id for row in rows)
                else (None, "source_unavailable"))
    if not rows:
        return None, "source_unavailable"
    if len(rows) > 1 and not reference.startswith(("上次", "最近")):
        return None, "ambiguous_activity"
    return _short_text(rows[0][0], 36), None
