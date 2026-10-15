from __future__ import annotations

import json
import base64
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from ai_engine.radar import repair as r
from ai_engine.llm.config import LlmRoute
from ai_engine.radar.distilled_scorer import DISTILLED_VERSION


def scored(tier: str = 'noise') -> dict[str, Any]:
    return {'id': 'row', 'title': 'An actual tool', 'body': 'source summary ' * 20,
            'interpretation': 'a technical judgement with sufficient details and concrete limitations',
            'canonicalUrl': 'https://example.org/article', 'sourceType': 'rss', 'tags': ['external_reading'],
            'distilledTier': tier, 'distilledScore': {'isDefault': False, 'version': DISTILLED_VERSION,
                'tier': tier, 'dimensions': dict.fromkeys('abcdefg', 1),
                'weakPoint': 'No implementation', 'weakPointEvidence': 'only a landing page'}}


def test_only_complete_grounded_current_noise_can_be_deleted() -> None:
    row = scored()
    full = r.Evidence('Evidence: only a landing page', 'article', True)
    assert r.noise_grounded(row, full)
    assert not r.noise_grounded(row, r.Evidence(full.text, 'source_abstract', False))
    assert not r.noise_grounded(row, r.Evidence('unrelated article evidence', 'article', True))
    row['distilledScore']['version'] = '4.7'
    assert not r.noise_grounded(row, full)
    assert r.has_score(row)  # Legacy scores are retained, not needlessly overwritten.


def test_invalid_score_and_summary_are_not_success() -> None:
    row = scored()
    row['distilledScore']['isDefault'] = True
    assert not r.has_score(row)
    row['distilledScore']['isDefault'] = False
    row['distilledScore']['dimensions'] = dict.fromkeys('abcdefg', 0)
    assert not r.has_score(row)
    row.update(body=row['title'], interpretation='')
    assert r.needs_summary(row)


async def test_valid_noise_never_spends_model_calls_on_brief_completion() -> None:
    row = {**scored(), 'body': '', 'interpretation': ''}
    assert not r.needs_summary(row)
    call = AsyncMock()
    assert await r.derive(row, r.Evidence('Only a verified source excerpt', 'source_excerpt', False),
                          call, fields='summary') == {}
    call.assert_not_awaited()
    row['distilledScore']['version'] = '4.7'
    assert not r.needs_summary(row)  # Still not permission to delete a legacy score.


@pytest.mark.parametrize('missing_body,missing_judgement', [(True, False), (False, True), (True, True)])
async def test_brief_repair_only_fills_missing_fields(missing_body, missing_judgement) -> None:
    row = scored('skim')
    if missing_body:
        row['body'] = ''
    if missing_judgement:
        row['interpretation'] = ''
    source = 'A verified implementation provides local execution and clearly documents its limitations. ' * 4
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps({
        'summary': '具体实现与限制。' * 20 if missing_body else '',
        'judgement': '适用场景与限制。' * 8 if missing_judgement else '', 'evidence_index': 0})))
    changes = await r.derive(row, r.Evidence(source, 'article', True), call, fields='summary')
    assert ('body' in changes) is missing_body
    assert ('interpretation' in changes) is missing_judgement
    assert 'distilledScore' not in changes


def test_retries_are_bounded_and_preserve_precise_reason() -> None:
    missing = r.RepairFailure('SOURCE_HTTP_404', '原始来源返回HTTP 404')
    one = r.retry_state(missing, 1, 1000)
    assert one['nextAttemptAt'] == 1300
    assert one['status'] == 'retry_wait'
    three = r.retry_state(missing, 3, 1000)
    assert three['status'] == 'blocked' and three['nextAttemptAt'] is None
    assert three['reason'] == '原始来源返回HTTP 404'
    quota = r.retry_state(r.RepairFailure('MODEL_QUOTA', 'quota'), 1, 1000)
    assert quota['nextAttemptAt'] == 4600
    assert r.retry_state(r.RepairFailure('MODEL_QUOTA', 'quota'), 5, 1000)['status'] == 'blocked'


def test_credential_repr_is_safe() -> None:
    route = LlmRoute('minimax', 'openai', 'test', 'https://example.org', 'a-secret-key', 'minimax:test')
    assert 'a-secret-key' not in str(route)
    assert 'a-secret-key' not in repr(route)
    assert route.api_key == 'a-secret-key'


async def test_abstract_never_claims_complete_source(monkeypatch: Any) -> None:
    doc = SimpleNamespace(status=200, url='https://arxiv.org/abs/2610.12345', headers={}, content=b'html')
    monkeypatch.setattr(r, 'safe_fetch', AsyncMock(return_value=doc))
    monkeypatch.setattr(r, '_arxiv_abstract_input', lambda *a: ('verified abstract', 'source_abstract'))
    row = {**scored(), 'canonicalUrl': doc.url, 'sourceType': 'arxiv'}
    evidence = await r.acquire_evidence(row)
    assert evidence.kind == 'source_abstract' and not evidence.complete


async def test_http_403_is_explicit_and_never_calls_model(monkeypatch: Any) -> None:
    doc = SimpleNamespace(status=403, url='https://example.org/article', headers={})
    monkeypatch.setattr(r, 'safe_fetch', AsyncMock(return_value=doc))
    with pytest.raises(r.RepairFailure) as caught:
        await r.acquire_evidence(scored())
    assert caught.value.code == 'SOURCE_HTTP_403'


async def test_pdf_evidence_uses_bounded_parser_and_never_overclaims_complete(monkeypatch: Any) -> None:
    from ai_engine.fetcher.pdf_text import PdfText, MAX_PDF_BYTES

    url = 'https://example.org/research.pdf'
    doc = SimpleNamespace(status=200, url=url, headers={'content-type': 'application/pdf'}, content=b'%PDF-source')
    fetch = AsyncMock(return_value=doc)
    parse = AsyncMock(return_value=PdfText('Verified technical evidence and limitations. ' * 800, True))
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    monkeypatch.setattr(r, 'read_pdf', parse)
    evidence = await r.acquire_evidence({**scored(), 'canonicalUrl': url})
    assert evidence.kind == 'source_pdf' and len(evidence.text) == 18000 and not evidence.complete
    assert fetch.call_args.kwargs['max_bytes'] == MAX_PDF_BYTES
    assert fetch.call_args.kwargs['max_redirects'] == 0 and fetch.call_args.kwargs['allow_pdf']
    parse.assert_awaited_once_with(doc.content)


@pytest.mark.parametrize('problem', ['identity', 'mime', 'encrypted'])
async def test_pdf_identity_and_parser_failure_cannot_reach_scoring(monkeypatch: Any, problem: str) -> None:
    from ai_engine.fetcher.pdf_text import PdfReadError

    url = 'https://example.org/research.pdf'
    doc = SimpleNamespace(status=200, url=url if problem != 'identity' else 'https://example.org/other.pdf',
                          headers={'content-type': 'text/html' if problem == 'mime' else 'application/pdf'},
                          content=b'%PDF-source')
    parser = AsyncMock(side_effect=PdfReadError('SOURCE_PDF_ENCRYPTED'))
    monkeypatch.setattr(r, 'safe_fetch', AsyncMock(return_value=doc))
    monkeypatch.setattr(r, 'read_pdf', parser)
    with pytest.raises(r.RepairFailure) as caught:
        await r.acquire_evidence({**scored(), 'canonicalUrl': url})
    assert not caught.value.retryable
    if problem == 'encrypted':
        assert caught.value.code == 'SOURCE_PDF_ENCRYPTED'
    else:
        assert caught.value.code == 'SOURCE_IDENTITY_MISMATCH'
        parser.assert_not_awaited()


def test_fetch_and_model_errors_have_precise_safe_reasons() -> None:
    from ai_engine.fetcher.safe_fetch import SafeFetchError, UpstreamHttpError

    error = r.failure(SafeFetchError('CONTENT_TYPE_REJECTED', 'private response with a secret'))
    assert error.code == 'CONTENT_TYPE_REJECTED' and not error.retryable
    assert 'secret' not in error.detail
    limited = r.failure(UpstreamHttpError('UPSTREAM_RATE_LIMITED', 'secret', status=429))
    assert limited.code == 'SOURCE_RATE_LIMITED'
    assert r.retry_state(limited, 1, 1000)['nextAttemptAt'] == 4600
    missing = r.failure(UpstreamHttpError('UPSTREAM_HTTP_ERROR', 'secret', status=404))
    assert missing.code == 'SOURCE_HTTP_404'
    assert r.retry_state(missing, 3, 1000)['status'] == 'blocked'

    class Rejected(Exception):
        status_code = 422

    rejected = r.failure(Rejected('request included secret credentials'))
    assert rejected.code == 'MODEL_REQUEST_REJECTED' and not rejected.retryable
    assert 'HTTP 422' in rejected.detail and 'secret' not in rejected.detail


@pytest.mark.parametrize('name,status,message,code,retryable', [
    ('InternalServerError', 503, 'private provider response', 'MODEL_UPSTREAM_ERROR', True),
    ('APITimeoutError', None, 'private request', 'MODEL_TIMEOUT', True),
    ('APIConnectionError', None, 'private endpoint', 'MODEL_CONNECTION', True),
    ('RuntimeError', None, 'LLM endpoint circuit open: private endpoint', 'MODEL_CIRCUIT_OPEN', True),
    ('RuntimeError', None, 'no usable LLM route configured', 'MODEL_CONFIGURATION', False),
])
def test_model_failures_report_actionable_safe_categories(name, status, message, code, retryable) -> None:
    cls = RuntimeError if name == 'RuntimeError' else type(name, (Exception,), {'status_code': status})
    result = r.failure(cls(message))
    assert result.code == code and result.retryable is retryable
    assert 'private' not in result.detail
    assert result.detail != name


def test_unclassified_error_records_code_location_without_request_text() -> None:
    try:
        raise RuntimeError('private request including sensitive-data')
    except RuntimeError as exc:
        result = r.failure(exc)
    assert result.code == 'REPAIR_RUNTIMEERROR'
    assert 'test_radar_repair.py:' in result.detail
    assert 'sensitive-data' not in result.detail and 'private request' not in result.detail


def test_row_version_updates_preserve_failed_retry_budget_and_model_usage() -> None:
    previous = {'observedUpdatedAt': 'before', 'attempts': 5, 'status': 'blocked', 'modelCalls': 8,
                'errorCode': 'SOURCE_HTTP_403', 'reason': '原始来源返回HTTP 403', 'nextAttemptAt': None}
    observed = r.observe_row(previous, {'updatedAt': 'after-display-only-governance'})
    assert observed == {**previous, 'observedUpdatedAt': 'after-display-only-governance'}
    assert previous['observedUpdatedAt'] == 'before'


def test_bounded_failure_message_preserves_json_and_stage() -> None:
    item = {'errorCode': 'REPAIR_RUNTIMEERROR', 'reason': '\n"detailed failure"' * 200,
            'attempts': 5, 'nextAttemptAt': None, 'status': 'blocked', 'failedPhase': 'write_summary'}
    message = r.failure_message(item)
    parsed = json.loads(message)
    assert len(message) <= 500
    assert parsed['failedPhase'] == 'write_summary' and parsed['attempts'] == 5
    assert parsed['errorCode'] == item['errorCode']
    assert item['reason'].startswith(parsed['reason'])


async def test_github_api_readme_preserves_size_proof(monkeypatch: Any) -> None:
    monkeypatch.setattr(r, '_github_api_retry_at', 0)
    text = 'This project implements a local execution engine with documented limitations. ' * 20
    api_url = 'https://api.github.com/repos/owner/repo/readme'
    payload = {'encoding': 'base64', 'content': base64.b64encode(text.encode()).decode(),
               'size': len(text.encode())}
    doc = SimpleNamespace(status=200, url=api_url, content=json.dumps(payload).encode(), headers={})
    fetch = AsyncMock(return_value=doc)
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    evidence = await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
    assert evidence.text == text and evidence.complete and evidence.kind == 'github_readme'
    assert fetch.await_count == 1
    payload['size'] += 1
    doc.content = json.dumps(payload).encode()
    with pytest.raises(r.RepairFailure, match='SOURCE_TRUNCATED'):
        await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')


async def test_verified_readme_allows_interior_error_example_without_changing_evidence(monkeypatch: Any) -> None:
    monkeypatch.setattr(r, '_github_api_retry_at', 0)
    text = '# Local execution\n' + ('A technical tool documents permissions and isolation. ' * 20) + '\nExample: access denied'
    assert not r._usable_content(text, source_type='github', url='https://github.com/owner/repo')
    payload = {'encoding': 'base64', 'content': base64.b64encode(text.encode()).decode(), 'size': len(text.encode())}
    async def fetch(url: str, **kwargs: Any) -> Any:
        return SimpleNamespace(status=200, url=url, headers={}, content=json.dumps(payload).encode())
    monkeypatch.setattr(r, 'safe_fetch', AsyncMock(side_effect=fetch))
    evidence = await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
    assert evidence.text == text and evidence.complete
    for bad in ('Access denied\n' + text, '<html>' + text, '# Access Denied\n' + text,
                'Enable javascript and cookies\n' + text):
        assert not r.usable_verified_markdown(bad, source_type='github', url='https://github.com/owner/repo')


@pytest.mark.parametrize('problem', [None, 'long', 'title', 'url', 'canonical', 'id', 'mime', 'redirect',
                                    'short', 'shell', 'json', 'array', 'status', 'rate'])
async def test_devto_api_requires_matching_publication_and_complete_body(monkeypatch: Any, problem: str | None) -> None:
    url = 'https://dev.to/author/technical-guide-1234'
    text = '# Local execution\n' + ('This guide documents API permissions and implementation limits. ' * 20)
    if problem == 'long':
        text *= 30
    elif problem == 'short':
        text = 'Only a title'
    elif problem == 'shell':
        text = 'Access denied\n' + text
    text += '\nWhen access denied occurs, check the configured permissions.'
    payload = {'id': 1234, 'url': url, 'canonical_url': url, 'title': 'Technical guide', 'body_markdown': text}
    if problem in {'title', 'url', 'canonical', 'id'}:
        key = {'canonical': 'canonical_url'}.get(problem, problem)
        payload[key] = True if problem == 'id' else 'different publication'
    doc = SimpleNamespace(status=429 if problem == 'rate' else 503 if problem == 'status' else 200,
                          url='https://dev.to/api/articles/another/guide' if problem == 'redirect'
                          else 'https://dev.to/api/articles/author/technical-guide-1234',
                          headers={'content-type': 'text/html' if problem == 'mime' else 'application/json; charset=utf-8'},
                          content=b'invalid json' if problem == 'json' else
                          json.dumps([] if problem == 'array' else payload).encode())
    fetch = AsyncMock(return_value=doc)
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    row = {**scored('skim'), 'title': 'Technical guide', 'canonicalUrl': url, 'sourceType': 'devto'}
    if problem in (None, 'long'):
        evidence = await r.acquire_evidence(row)
        assert evidence.kind == 'devto_article_api' and evidence.text == text[:18000]
        assert evidence.complete is (problem is None)
        assert not r.noise_grounded(scored(), r.Evidence(evidence.text, evidence.kind, False))
    else:
        with pytest.raises(r.RepairFailure) as error:
            await r.acquire_evidence(row)
        expected = ('SOURCE_INSUFFICIENT' if problem in {'short', 'shell'} else
                    'SOURCE_INVALID_ARTICLE' if problem in {'json', 'array'} else
                    'SOURCE_HTTP_503' if problem == 'status' else
                    'SOURCE_RATE_LIMITED' if problem == 'rate' else 'SOURCE_IDENTITY_MISMATCH')
        assert error.value.code == expected
    fetch.assert_awaited_once_with('https://dev.to/api/articles/author/technical-guide-1234',
                                  allowed_hosts=('dev.to',), max_bytes=1_000_000, timeout=10, max_redirects=0)


@pytest.mark.parametrize('url', ['http://dev.to/author/slug', 'https://dev.to:443/author/slug',
                               'https://dev.to/author/slug?other=1', 'https://dev.to/author/../slug'])
async def test_devto_unsafe_identity_is_rejected_without_fetch(monkeypatch: Any, url: str) -> None:
    fetch = AsyncMock()
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    with pytest.raises(r.RepairFailure, match='SOURCE_UNSAFE_URL'):
        await r.devto_article_evidence({**scored(), 'canonicalUrl': url})
    fetch.assert_not_awaited()


async def test_devto_legacy_widget_cache_cannot_replace_verified_article_body(monkeypatch: Any) -> None:
    row = {**scored('skim'), 'canonicalUrl': 'https://dev.to/author/technical-guide-1234',
           'originalMarkdown': 'Unrelated sidebar promotion and navigation. ' * 50}
    assert r._usable_content(row['originalMarkdown'], source_type='devto', url=row['canonicalUrl'])
    evidence = r.Evidence('Official matching article body', 'devto_article_api', True)
    adapter = AsyncMock(return_value=evidence)
    monkeypatch.setattr(r, 'devto_article_evidence', adapter)
    assert await r.acquire_evidence(row) is evidence
    adapter.assert_awaited_once_with(row)
    assert row['originalMarkdown'].startswith('Unrelated sidebar promotion')
    adapter.side_effect = r.RepairFailure('SOURCE_IDENTITY_MISMATCH', 'different publication', retryable=False)
    with pytest.raises(r.RepairFailure, match='SOURCE_IDENTITY_MISMATCH'):
        await r.acquire_evidence(row)  # An API failure must never fall back to the old widget cache.


async def test_github_api_cooldown_uses_same_repo_raw_readme(monkeypatch: Any) -> None:
    monkeypatch.setattr(r, '_github_api_retry_at', 0)
    monkeypatch.setattr(r.time, 'time', lambda: 1000)
    text = 'This project implements a local execution engine with documented limitations. ' * 20

    async def fetch(url: str, **kwargs: Any) -> Any:
        assert kwargs['max_redirects'] == 0
        if 'api.github.com' in url:
            return SimpleNamespace(status=403, url=url, headers={'x-ratelimit-remaining': '0'})
        assert kwargs['allowed_hosts'] == ('raw.githubusercontent.com',)
        return SimpleNamespace(status=200, url=url, headers={'content-type': 'text/plain'}, content=text.encode())

    mock = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(r, 'safe_fetch', mock)
    evidence = await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
    assert evidence.complete and evidence.kind == 'github_raw_readme' and evidence.text == text
    assert r._github_api_retry_at == 4600
    await r.github_readme_evidence('other/repo', 'https://github.com/other/repo')
    assert [call.args[0] for call in mock.await_args_list] == [
        'https://api.github.com/repos/owner/repo/readme',
        'https://raw.githubusercontent.com/owner/repo/HEAD/README.md',
        'https://raw.githubusercontent.com/other/repo/HEAD/README.md',
    ]


async def test_github_api_redirect_reads_original_raw_repo_without_following_target(monkeypatch: Any) -> None:
    from ai_engine.fetcher.safe_fetch import SafeFetchError

    monkeypatch.setattr(r, '_github_api_retry_at', 0)
    text = 'The original repository documents its implementation and limitations. ' * 20

    async def fetch(url: str, **kwargs: Any) -> Any:
        assert kwargs['max_redirects'] == 0
        if url == 'https://api.github.com/repos/owner/repo/readme':
            raise SafeFetchError('URL_REDIRECT_LIMIT', 'redirected more than 0 times')
        assert url == 'https://raw.githubusercontent.com/owner/repo/HEAD/README.md'
        return SimpleNamespace(status=200, url=url, headers={'content-type': 'text/plain'}, content=text.encode())

    mock = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(r, 'safe_fetch', mock)
    evidence = await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
    assert evidence.text == text and evidence.kind == 'github_raw_readme' and evidence.complete
    assert mock.await_count == 2
    assert r._github_api_retry_at == 0


async def test_github_api_safety_rejection_cannot_be_hidden_by_raw_fallback(monkeypatch: Any) -> None:
    from ai_engine.fetcher.safe_fetch import SafeFetchError

    monkeypatch.setattr(r, '_github_api_retry_at', 0)
    fetch = AsyncMock(side_effect=SafeFetchError('URL_FETCH_BLOCKED', 'blocked destination'))
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    with pytest.raises(SafeFetchError) as error:
        await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
    assert error.value.code == 'URL_FETCH_BLOCKED'
    assert fetch.await_count == 1


@pytest.mark.parametrize('problem', ['html', 'identity', 'large', 'missing'])
async def test_raw_readme_does_not_overclaim_identity_or_completeness(monkeypatch: Any, problem: str) -> None:
    monkeypatch.setattr(r, '_github_api_retry_at', float('inf'))
    text = 'This project implements a local execution engine with documented limitations. ' * 300

    async def fetch(url: str, **kwargs: Any) -> Any:
        return SimpleNamespace(status=404 if problem == 'missing' else 200,
                               url=url + '/redirect' if problem == 'identity' else url,
                               headers={'content-type': 'text/html' if problem == 'html' else 'text/plain'},
                               content=text.encode())

    monkeypatch.setattr(r, 'safe_fetch', AsyncMock(side_effect=fetch))
    if problem == 'large':
        evidence = await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
        assert len(evidence.text) == 18000 and not evidence.complete
    else:
        with pytest.raises(r.RepairFailure) as caught:
            await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
        assert caught.value.code == ('SOURCE_GITHUB_API_RATE_LIMITED' if problem == 'missing'
                                     else 'SOURCE_IDENTITY_MISMATCH')


@pytest.mark.parametrize('code,expected_fetches', [('SOURCE_GITHUB_API_RATE_LIMITED', 2),
                                                ('SOURCE_RATE_LIMITED', 1)])
async def test_api_only_rate_limit_does_not_pause_other_raw_repositories(
    tmp_path, monkeypatch, code, expected_fetches,
) -> None:
    from contextlib import asynccontextmanager

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield None

    rows = [{**scored('skim'), 'id': sid, 'canonicalUrl': f'https://github.com/owner/{sid}',
             'updatedAt': 'now', 'body': ''} for sid in ('unknown-readme', 'readable-raw')]
    monkeypatch.setattr(r.g, 'verify_admin', AsyncMock(return_value='actor'))
    monkeypatch.setattr(r.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(r.g, 'protected_ids', AsyncMock(return_value={}))
    monkeypatch.setattr(r, 'inventory', AsyncMock(return_value=rows))
    monkeypatch.setattr(r, 'record_failure', AsyncMock())
    monkeypatch.setattr(r, 'derive', AsyncMock(return_value={}))
    fetch = AsyncMock(side_effect=[r.RepairFailure(code, 'limited'), r.Evidence('source', 'github_raw_readme', True)])
    monkeypatch.setattr(r, 'acquire_evidence', fetch)
    await r.cycle(Pool(), 'actor', tmp_path)
    state = json.loads((tmp_path/'state.json').read_text())
    assert fetch.await_count == expected_fetches
    assert bool(state.get('sourcePauses', {}).get('github.com')) is (code == 'SOURCE_RATE_LIMITED')
    first = state['items']['unknown-readme']
    assert first['status'] == 'retry_wait'
    assert first['nextAttemptAt'] == pytest.approx(first['startedAt'] + 3600, abs=1)
    assert r.retry_state(r.RepairFailure(code, 'limited'), 5, 1000)['status'] == 'blocked'
    assert state['modelCalls'] == 0


async def test_readme_path_fallback_and_traversal_are_bounded(monkeypatch: Any) -> None:
    monkeypatch.setattr(r, '_github_api_retry_at', 0)
    text = 'This project implements a local execution engine with documented limitations. ' * 20

    async def fetch(url: str, **kwargs: Any) -> Any:
        return SimpleNamespace(status=200 if url.endswith('/README.rst') else 404,
                               url=url, headers={}, content=text.encode())

    mock = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(r, 'safe_fetch', mock)
    evidence = await r.github_readme_evidence('owner/repo', 'https://github.com/owner/repo')
    assert evidence.complete and mock.await_count == 3
    for identity in ('../repo', 'owner/..', 'owner/repo/another'):
        with pytest.raises(r.RepairFailure, match='SOURCE_UNSAFE_URL'):
            await r.github_readme_evidence(identity, 'https://github.com/' + identity)
    assert mock.await_count == 3


async def test_summary_requires_grounded_quote_and_preserves_valid_score() -> None:
    source = 'Precise source evidence and implementation limitations. ' * 30
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps({
        'summary': '基于原文的具体能力、方法与限制。' * 10,
        'judgement': '适用于受控工具调用环境，性能和可靠性仍需在实际任务中验证。' * 2,
        'evidence_quote': 'Precise source evidence and implementation limitations.',
    })))
    row = {**scored('skim'), 'interpretation': '', 'body': 'title only'}
    changes = await r.derive(row, r.Evidence(source, 'article', True), call)
    assert 'distilledScore' not in changes
    assert len(changes['body']) >= 80
    assert call.await_count == 1
    call.return_value = SimpleNamespace(text=json.dumps({'summary': '摘要' * 100,
                                                        'judgement': '判断' * 30, 'evidence_quote': 'invented quote'}))
    with pytest.raises(r.RepairFailure, match='MODEL_SUMMARY_INVALID'):
        await r.derive(row, r.Evidence(source, 'article', True), call)
    call.return_value = SimpleNamespace(text=json.dumps({
        'summary': '摘要' * 100, 'judgement': '判断' * 30,
        'evidence_quote': 'Precise source evidence and implementation limitations.',
    }))
    layout_source = source.replace('source evidence', 'source\n    evidence')
    assert 'interpretation' in await r.derive(row, r.Evidence(layout_source, 'article', True), call)
    call.return_value = SimpleNamespace(text=json.dumps({
        'summary': '短', 'judgement': '短', 'evidence_quote': 'invented quote',
    }))
    with pytest.raises(r.RepairFailure) as caught:
        await r.derive(row, r.Evidence(source, 'article', True), call)
    assert '摘要字符数1' in caught.value.detail
    assert '判断字符数1' in caught.value.detail
    assert '无法逐字匹配原文' in caught.value.detail
    call.return_value = SimpleNamespace(text=json.dumps({
        'summary': '摘要' * 100, 'judgement': '判断' * 30, 'evidence_index': 0,
    }))
    assert 'interpretation' in await r.derive(row, r.Evidence(source, 'article', True), call)
    assert '<untrusted-source-quote-options>' in call.await_args.kwargs['user_prompt']
    for index in (True, -1, 999):
        call.return_value = SimpleNamespace(text=json.dumps({
            'summary': '摘要' * 100, 'judgement': '判断' * 30, 'evidence_index': index,
        }))
        with pytest.raises(r.RepairFailure, match='MODEL_SUMMARY_INVALID'):
            await r.derive(row, r.Evidence(source, 'article', True), call)


async def test_model_error_never_persists_fake_scores() -> None:
    row = {**scored(), 'distilledScore': None}
    call = AsyncMock(return_value=SimpleNamespace(text='not valid JSON'))
    with pytest.raises(r.RepairFailure, match='MODEL_SCORE_FORMAT'):
        await r.derive(row, r.Evidence('source evidence ' * 60, 'article', True), call)


async def test_long_failure_placeholder_gets_a_real_summary_without_overwriting_score() -> None:
    row = {**scored('skim'), 'tags': [], 'body': '抓取失败，请查看原文。' * 20}
    assert r.needs_summary(row)
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps({
        'summary': '具体能力与方法，以及来源明确披露的工程限制。' * 8,
        'judgement': '适用于受控环境验证，部署前还需评估来源中未覆盖的可靠性限制。' * 2,
        'evidence_quote': 'Precise source evidence and implementation limitations.',
    })))
    changes = await r.derive(row, r.Evidence('Precise source evidence and implementation limitations. ' * 20,
                                          'article', False), call, fields='summary')
    assert 'body' in changes and 'distilledScore' not in changes
    assert not r.needs_summary({**row, **changes})


def test_article_container_is_not_proof_of_completeness() -> None:
    text = 'A substantive technical article. ' * 40
    html = '<html><article>' + text + '</article></html>'
    assert not r.complete_article(html, text, 'https://example.org/article')
    payload = json.dumps({'@type': 'TechArticle', 'articleBody': text})
    html = html.replace('</html>', '<script type="application/ld+json">' + payload + '</script></html>')
    assert r.complete_article(html, text, 'https://example.org/article')
    assert not r.complete_article(html.replace('<article>', '<article class="paywall">'), text, 'https://example.org/article')
    assert not r.complete_article(html.replace('"articleBody"', '"excerpt"'), text, 'https://example.org/article')
    assert not r.complete_article(html.replace('"@type":', '"isAccessibleForFree": false, "@type":'), text, 'https://example.org/article')


def test_publication_identity_preserves_new_article_and_utc_equivalence() -> None:
    from ai_engine.radar.diagnostic_policy import publication_identity as identity
    assert identity(' Article ', '2026-10-15T08:00:00+08:00') == identity('article', '2026-10-15T00:00:00Z')
    assert identity('article', None) != identity('new article', None)
    assert identity('article', '2026-10-15T00:00:00Z') != identity('article', '2026-10-16T00:00:00Z')


async def test_cycle_saves_successful_score_before_summary_failure_and_resumes(tmp_path, monkeypatch) -> None:
    from contextlib import asynccontextmanager
    row = {**scored('skim'), 'id': 'test-id', 'updatedAt': 'before', 'distilledScore': None, 'interpretation': ''}
    class Cursor:
        async def fetchone(self):
            return dict(row)
    class Conn:
        async def execute(self, *args):
            return Cursor()
    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Conn()
    monkeypatch.setattr(r.g, 'verify_admin', AsyncMock(return_value='actor'))
    monkeypatch.setattr(r.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(r.g, 'protected_ids', AsyncMock(return_value={}))
    monkeypatch.setattr(r, 'inventory', AsyncMock(side_effect=lambda _: [dict(row)]))
    monkeypatch.setattr(r, 'acquire_evidence', AsyncMock(return_value=r.Evidence('source', 'article', False)))
    monkeypatch.setattr(r, 'record_failure', AsyncMock())
    phase_calls = []
    async def derive(current, evidence, call, *, fields):
        if fields == 'score' and not r.has_score(current):
            phase_calls.append('score')
            return {'distilledScore': scored('skim')['distilledScore']}
        if fields == 'summary':
            phase_calls.append('summary')
            raise r.RepairFailure('MODEL_SUMMARY_INVALID', 'invalid summary')
        return {}
    async def mutate(*args, **kwargs):
        row.update(args[4], updatedAt='after-score')
        return 'repaired'
    monkeypatch.setattr(r, 'derive', derive)
    monkeypatch.setattr(r, 'mutate', mutate)
    await r.cycle(Pool(), 'actor', tmp_path)
    state = json.loads((tmp_path / 'state.json').read_text())
    assert r.has_score(row)
    assert state['items']['test-id']['status'] == 'retry_wait'
    assert state['items']['test-id']['failedPhase'] == 'summary'
    assert state['items']['test-id']['observedUpdatedAt'] == 'after-score'
    await r.cycle(Pool(), 'actor', tmp_path)
    assert phase_calls == ['score', 'summary']  # Cooldown prevents duplicate charge.
    state['items']['test-id']['nextAttemptAt'] = 0
    r.g.save(tmp_path / 'state.json', state)
    await r.cycle(Pool(), 'actor', tmp_path)
    state = json.loads((tmp_path / 'state.json').read_text())
    assert phase_calls == ['score', 'summary', 'summary']
    assert state['items']['test-id']['attempts'] == 2


@pytest.mark.parametrize('previous,attempts,expected', [('running', 1, 'retry_wait'),
                                                     ('complete', 1, 'retry_wait'), ('complete', 5, 'blocked')])
async def test_interrupted_or_false_completion_keeps_budget_and_retry_limit(
    tmp_path, monkeypatch, previous, attempts, expected,
) -> None:
    from contextlib import asynccontextmanager
    row = {**scored(), 'id': 'interrupted', 'updatedAt': 'after-display-change', 'distilledScore': None}
    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield None
    monkeypatch.setattr(r.g, 'verify_admin', AsyncMock(return_value='actor'))
    monkeypatch.setattr(r.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(r.g, 'protected_ids', AsyncMock(return_value={}))
    monkeypatch.setattr(r, 'inventory', AsyncMock(return_value=[row]))
    monkeypatch.setattr(r, 'record_failure', AsyncMock())
    fetch = AsyncMock()
    monkeypatch.setattr(r, 'acquire_evidence', fetch)
    r.g.save(tmp_path / 'state.json', {'modelCalls': 1, 'items': {'interrupted': {
        'observedUpdatedAt': 'before', 'attempts': attempts, 'status': previous, 'modelCalls': 1}}})
    await r.cycle(Pool(), 'actor', tmp_path)
    state = json.loads((tmp_path / 'state.json').read_text())
    assert state['modelCalls'] == 1
    assert state['items']['interrupted']['errorCode'] == ('RECOVERY_INTERRUPTED' if previous=='running' else 'REPAIR_INCOMPLETE')
    assert state['items']['interrupted']['status'] == expected
    assert state['items']['interrupted']['attempts'] == attempts
    fetch.assert_not_awaited()


@pytest.mark.parametrize('previous,next_at', [('blocked', None), ('retry_wait', 9999999999)])
async def test_display_changes_do_not_restart_blocked_or_cooling_items(tmp_path, monkeypatch, previous, next_at) -> None:
    from contextlib import asynccontextmanager

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield None

    row = {**scored(), 'id': 'same-content', 'updatedAt': 'after-display-governance', 'distilledScore': None}
    monkeypatch.setattr(r.g, 'verify_admin', AsyncMock(return_value='actor'))
    monkeypatch.setattr(r.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(r.g, 'protected_ids', AsyncMock(return_value={}))
    monkeypatch.setattr(r, 'inventory', AsyncMock(return_value=[row]))
    fetch = AsyncMock()
    monkeypatch.setattr(r, 'acquire_evidence', fetch)
    r.g.save(tmp_path / 'state.json', {'modelCalls': 7, 'items': {'same-content': {
        'observedUpdatedAt': 'before', 'attempts': 5, 'status': previous, 'modelCalls': 7,
        'errorCode': 'SOURCE_HTTP_403', 'reason': 'HTTP 403', 'nextAttemptAt': next_at}}})
    result = await r.cycle(Pool(), 'actor', tmp_path)
    item = json.loads((tmp_path / 'state.json').read_text())['items']['same-content']
    assert result['processed'] == 0 and result['modelCalls'] == 7
    assert item['attempts'] == 5 and item['modelCalls'] == 7
    assert item['observedUpdatedAt'] == row['updatedAt']
    assert item['status'] == previous and item['nextAttemptAt'] == next_at
    fetch.assert_not_awaited()


async def test_explicit_requeue_audits_previous_budget_and_preserves_usage(tmp_path, monkeypatch) -> None:
    from contextlib import asynccontextmanager

    class Conn:
        @asynccontextmanager
        async def transaction(self):
            yield

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Conn()

    monkeypatch.setattr(r.g, 'verify_admin', AsyncMock(return_value='actor'))
    backup = Mock()
    monkeypatch.setattr(r.g, 'verify_backup', backup)
    audit = AsyncMock()
    monkeypatch.setattr(r, 'audit', audit)
    previous = {'observedUpdatedAt': 'before', 'attempts': 5, 'status': 'blocked', 'modelCalls': 7}
    r.g.save(tmp_path / 'state.json', {'modelCalls': 7, 'items': {'same-content': previous}})
    await r.requeue(Pool(), 'actor', tmp_path, 'same-content', 'source access restored and verified')
    state = json.loads((tmp_path / 'state.json').read_text())
    assert state['modelCalls'] == 7 and state['items']['same-content']['modelCalls'] == 7
    assert state['items']['same-content']['attempts'] == 0
    assert state['requeueHistory'][0]['previous'] == previous
    assert audit.await_args.args[-1]['previous'] == previous
    backup.assert_called_once()
