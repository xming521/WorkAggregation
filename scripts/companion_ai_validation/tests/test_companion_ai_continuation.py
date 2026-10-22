"""Offline immutable predecessor, strict ledger replay and lineage mutation tests."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import stat
import zipfile

import pytest

from scripts.companion_ai_validation import continuation as c


def members():
    with zipfile.ZipFile(c.EVIDENCE_PATH) as archive:
        return {name: archive.read(name) for name in c.MEMBERS}


def ledger():
    return [json.loads(line) for line in members()['budget.jsonl'].splitlines()]


def encoded(rows):
    return b''.join(json.dumps(row, separators=(',', ':')).encode() + b'\n' for row in rows)


def repack(values, monkeypatch, *, extra=None, duplicate=None, mode=None):
    """Repin outer hashes ONLY in tests to exercise inner validation independently."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, raw in values.items():
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFREG | 0o600 if mode is None else mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, raw)
        if extra:
            archive.writestr(extra, b'x')
        if duplicate:
            with pytest.warns(UserWarning, match='Duplicate name'):
                archive.writestr(duplicate, values[duplicate])
    raw = output.getvalue()
    monkeypatch.setattr(c, 'ARCHIVE_SHA256', hashlib.sha256(raw).hexdigest())
    monkeypatch.setattr(c, 'ARCHIVE_SIZE', len(raw))
    monkeypatch.setattr(c, 'MEMBERS', {name: (len(value), hashlib.sha256(value).hexdigest())
                                     for name, value in values.items()})
    return raw


def test_real_pinned_bundle_verifies_exact_known_liability_and_no_arguments():
    original = c.EVIDENCE_PATH.read_bytes()
    assert len(original) == 17499
    assert hashlib.sha256(original).hexdigest() == c.ARCHIVE_SHA256
    prior = c.verified_predecessor()
    assert (prior.settled_micro_cny, prior.reserved_micro_cny, prior.request_count) == (103154, 0, 12)
    assert prior.run_id == 39736858377 and prior.artifact_id == 12408325852
    assert c.BUDGET - prior.settled_micro_cny == 19896846
    with pytest.raises(FrozenInstanceError):
        prior.settled_micro_cny = 0
    with pytest.raises(TypeError):
        c.verified_predecessor(0)
    with pytest.raises(TypeError):
        c.lineage_fields('/tmp/arbitrary-ledger')


def test_lineage_is_fresh_exact_and_fixed_not_a_new_budget():
    fields = c.lineage_fields()
    assert set(fields) == c.LINEAGE_KEYS
    assert fields['campaign_id'] == 'one-shot-20261021'
    assert fields['correction_ordinal'] == 1
    assert fields['prior_request_count'] == 12
    assert fields['price_valid_until'] == int(datetime(2026, 10, 24, tzinfo=timezone.utc).timestamp())
    c.validate_lineage({**fields, 'schema': 2, 'source_sha': 'b' * 40})
    fields['prior_settled_micro_cny'] = 0
    assert c.lineage_fields()['prior_settled_micro_cny'] == 103154
    with pytest.raises(c.ContinuationError, match='CONTINUATION_LINEAGE_MISMATCH'):
        c.validate_lineage(fields)


@pytest.mark.parametrize('key', sorted(c.LINEAGE_KEYS))
@pytest.mark.parametrize('mutation', ['missing', 'wrong_value', 'wrong_type'])
def test_every_lineage_field_is_mandatory_typed_and_exact(key, mutation):
    fields = c.lineage_fields()
    if mutation == 'missing':
        del fields[key]
    elif mutation == 'wrong_value':
        fields[key] = fields[key] + 1 if type(fields[key]) is int else fields[key] + '-changed'
    else:
        fields[key] = float(fields[key]) if type(fields[key]) is int else None
    with pytest.raises(c.ContinuationError, match='CONTINUATION_LINEAGE_MISMATCH'):
        c.validate_lineage(fields)


def test_boolean_cannot_equal_numeric_ordinal():
    fields = c.lineage_fields()
    fields['correction_ordinal'] = True
    with pytest.raises(c.ContinuationError):
        c.validate_lineage(fields)


@pytest.mark.parametrize('damage', ['missing', 'directory', 'symlink', 'changed', 'short', 'long'])
def test_unavailable_or_changed_bundle_never_supplies_a_balance(tmp_path, monkeypatch, damage):
    path = tmp_path / 'bundle.zip'
    original = c.EVIDENCE_PATH.read_bytes()
    if damage == 'directory':
        path.mkdir()
    elif damage == 'symlink':
        path.symlink_to(c.EVIDENCE_PATH)
    elif damage != 'missing':
        raw = original[:-1] if damage == 'short' else original + b'x' if damage == 'long' else b'x' + original[1:]
        path.write_bytes(raw)
    monkeypatch.setattr(c, 'EVIDENCE_PATH', path)
    for method in (c.verified_predecessor, c.lineage_fields):
        with pytest.raises(c.ContinuationError):
            method()


def test_verification_reopens_bytes_instead_of_caching_success(tmp_path, monkeypatch):
    path = tmp_path / 'bundle.zip'
    path.write_bytes(c.EVIDENCE_PATH.read_bytes())
    monkeypatch.setattr(c, 'EVIDENCE_PATH', path)
    assert c.verified_predecessor().request_count == 12
    path.write_bytes(b'changed after first check')
    with pytest.raises(c.ContinuationError):
        c.verified_predecessor()


def test_normal_closed_true_is_not_an_unknown_halt():
    rows = ledger()
    assert rows[-1]['event'] == 'closed' and rows[-1]['halted'] is True
    result = c._replay_ledger(encoded(rows))
    assert result == {'schema': 1, 'source_sha': c.PREDECESSOR_SOURCE_SHA,
                      'request_count': 12, 'settled_micro_cny': 103154,
                      'reserved_micro_cny': 0, 'budget_micro_cny': 20000000, 'halted': False}


@pytest.mark.parametrize('index,key,value', [
    (0, 'schema', True), (0, 'schema', 1.0), (0, 'source_sha', 'a' * 40),
    (0, 'settled_micro_cny', 103154), (0, 'reserved_micro_cny', 3000000),
    (0, 'budget_micro_cny', 40000000), (0, 'request_count', 0.0),
    (1, 'request_count', True), (1, 'reserved_micro_cny', 0), (1, 'reserved_micro_cny', 2999999),
    (1, 'settled_micro_cny', -1), (1, 'body_sha256', 'x' * 64),
    (1, 'operation', 'different'), (1, 'halted', True),
    (2, 'cost_micro_cny', 0), (2, 'cost_micro_cny', 8192.0),
    (2, 'prompt_tokens', True), (2, 'prompt_tokens', -1), (2, 'prompt_tokens', 1048577),
    (2, 'completion_tokens', 513), (2, 'completion_tokens', 28.0),
    (2, 'reserved_micro_cny', 3000000), (2, 'event', 'halted'),
    (3, 'calls', True), (3, 'calls', 2), (3, 'halted', True),
    (-1, 'halted', False), (-1, 'event', 'halted'), (-1, 'reserved_micro_cny', 3000000),
    (-1, 'settled_micro_cny', 0), (-1, 'request_count', 11),
])
def test_replay_rejects_unknown_refund_wrong_types_and_arithmetic(index, key, value):
    rows = ledger()
    rows[index][key] = value
    with pytest.raises(c.ContinuationError):
        c._replay_ledger(encoded(rows))


@pytest.mark.parametrize('mutation', ['drop', 'extra', 'reorder', 'extra_key', 'missing_key',
                                      'duplicate_key', 'nonfinite', 'no_newline', 'blank_line'])
def test_replay_requires_complete_unambiguous_ordered_journal(mutation):
    rows = ledger()
    if mutation == 'drop':
        rows.pop()
    elif mutation == 'extra':
        rows.append(deepcopy(rows[-1]))
    elif mutation == 'reorder':
        rows[1], rows[2] = rows[2], rows[1]
    elif mutation == 'extra_key':
        rows[0]['starting_balance'] = 0
    elif mutation == 'missing_key':
        rows[0].pop('halted')
    raw = encoded(rows)
    if mutation == 'duplicate_key':
        raw = raw.replace(b'"schema":1', b'"schema":0,"schema":1', 1)
    elif mutation == 'nonfinite':
        raw = raw.replace(b'"schema":1', b'"schema":NaN', 1)
    elif mutation == 'no_newline':
        raw = raw[:-1]
    elif mutation == 'blank_line':
        raw += b'\n'
    with pytest.raises(c.ContinuationError):
        c._replay_ledger(raw)


@pytest.mark.parametrize('damage', ['extra', 'traversal', 'duplicate', 'symlink', 'directory'])
def test_archive_structure_cannot_smuggle_other_files(monkeypatch, damage):
    kwargs = {}
    if damage in ('extra', 'traversal'):
        kwargs['extra'] = '../elsewhere' if damage == 'traversal' else 'unexpected.txt'
    elif damage == 'duplicate':
        kwargs['duplicate'] = 'budget.jsonl'
    else:
        kwargs['mode'] = (stat.S_IFLNK if damage == 'symlink' else stat.S_IFDIR) | 0o600
    raw = repack(members(), monkeypatch, **kwargs)
    with pytest.raises(c.ContinuationError):
        c._verify_archive(raw)


@pytest.mark.parametrize('damage', ['summary_budget', 'summary_type', 'summary_scope', 'summary_count',
                                    'summary_responses', 'response_order', 'response_read_only',
                                    'response_count', 'response_text'])
def test_summary_and_successful_dialogue_must_match_replayed_budget(monkeypatch, damage):
    values = members()
    summary = json.loads(values['summary.json'])
    responses = [json.loads(line) for line in values['responses.jsonl'].splitlines()]
    if damage == 'summary_budget':
        summary['budget']['settled_micro_cny'] = 0
    elif damage == 'summary_type':
        summary['budget']['stages_complete'] = 12.0
    elif damage == 'summary_scope':
        summary['matrix']['pass_scope'] = 'persona_accepted'
    elif damage == 'summary_count':
        summary['matrix']['ordinary_count'] = 8
    elif damage == 'summary_responses':
        summary['matrix']['responses'] = []
    else:
        if damage == 'response_order':
            responses[0], responses[1] = responses[1], responses[0]
        elif damage == 'response_read_only':
            responses[0]['ordinary_turn_read_only'] = 1
        elif damage == 'response_count':
            responses.pop()
        else:
            responses[0]['assistant_text'] = ''
        summary['matrix']['responses'] = responses
    values['summary.json'] = json.dumps(summary).encode()
    values['responses.jsonl'] = encoded(responses)
    raw = repack(values, monkeypatch)
    with pytest.raises(c.ContinuationError):
        c._verify_archive(raw)


def test_evidence_module_has_no_broker_or_network_dependency():
    source = Path(c.__file__).read_text()
    assert 'import broker' not in source and 'from scripts.' not in source
    assert 'import http' not in source and 'import urllib' not in source
