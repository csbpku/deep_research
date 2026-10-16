"""Real refusal summaries, genuine uncertainty and bounded regeneration."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ai_engine.radar import repair
from ai_engine.radar.brief_quality import is_unavailable_brief
from ai_engine.radar.sync_runner import _generate_brief_with_retry, _safe_error_code


@pytest.mark.parametrize('text', [
    '根据当前可获取的信息，仅有标题及HN帖子元数据，没有可用的正文内容。因此无法概述文章要解决的问题。',
    '根据现有信息，原始文章的具体内容并未提供，仅有标题，因此无法可靠地总结其所采用的关键方法。',
    '抱歉，您提供的内容不足以撰写符合要求的摘要。' + '目前只有帖子元数据。' * 30,
    '该来源仅包含一条HN提交信息，但未提供文档正文或摘要内容。因此无法生成实质性摘要。',
    '根据现有信息，原文全文不可用，以下摘要仅基于标题内容撰写，未涉及原文细节。',
    '无法生成摘要：没有文章正文、技术内容、性能数据或价格分析等实质信息。',
    '根据提供的内容，仅有HN提交信息，摘要正文及论文具体内容并未给出，无法对论文进行准确概述。',
    '根据目前可获取的资料，该论文的HTML全文无法获取，仅有标题信息，因此无法了解其研究的问题、方法、结果。',
    '无法提供摘要。网页原始内容不可用，仅有HTML转换失败的提示。',
    '无法生成摘要。所提供的网页数据仅包含一条错误提示信息。',
    '无法提供摘要，因为来源未能提供可读取的论文内容。',
    '无法提供摘要——所提供的网页内容仅包含一条错误提示，没有可读取的原文正文。',
    '无法生成摘要：所提供的网页内容仅包含一条HTML转换失败的提示。',
    "Sorry, I cannot summarize the article because the supplied content is just a title.",
])
def test_long_source_absence_is_not_a_completed_brief(text):
    assert is_unavailable_brief(text)


@pytest.mark.parametrize('text', [
    '本文研究工具调用评判器在缺少参考文本时的表现，实验发现评判器倾向接受可见但错误的值。',
    '适用于工具调用验证，限制在于证据仅为标题与摘要片段，使用前需核对具体实验数据与设定。',
    '该工具检测摘要生成失败并重试，无法生成摘要时向用户明确报告失败原因，保留原始证据。',
    '该论文基于公开摘要介绍方法和定量结果，全文实验细节仍需核验。',
    'The article examines why models cannot summarize documents after context truncation.',
])
def test_real_summaries_and_honest_limits_are_preserved(text):
    assert not is_unavailable_brief(text)


def scored_row():
    from ai_engine.radar.distilled_scorer import DIM_NAMES
    return {'title': 'Verified source', 'canonicalUrl': 'https://example.org/article', 'sourceType': 'rss',
            'distilledScore': {'isDefault': False, 'tier': 'skim', 'dimensions': dict.fromkeys(DIM_NAMES, 2)},
            'distilledTier': 'skim', 'body': 'Existing useful content with concrete facts. ' * 8,
            'interpretation': 'A useful decision with explicit limitations. ' * 3}


async def test_repair_replaces_only_placeholder_fields_preserving_valid_score():
    placeholder = '无法生成摘要：只有元数据，未提供文章正文。' * 10
    row = {**scored_row(), 'body': placeholder, 'interpretation': placeholder}
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps({
        'summary': '文章给出了明确的实现方法、可复核实验及性能限制。' * 8,
        'judgement': '适用于原型验证；生产部署仍需检查文中未覆盖的稳定性边界。' * 2,
        'evidence_quote': 'Concrete implementation and measured limitations.',
    })))
    changes = await repair.derive(row, repair.Evidence('Concrete implementation and measured limitations. ' * 30,
                                                       'article', True), call, fields='summary')
    assert changes['body'] != placeholder and changes['interpretation'] != placeholder
    assert 'distilledScore' not in changes and not repair.needs_summary({**row, **changes})
    call.assert_awaited_once()


async def test_regeneration_cannot_accept_another_long_refusal():
    row = {**scored_row(), 'body': '无法生成摘要。' * 30}
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps({
        'summary': '无法生成摘要：来源只包含一个标题，没有正文。' * 8,
        'judgement': '现有判断保持，不因摘要补齐而覆盖。' * 4,
        'evidence_quote': 'Concrete implementation and measured limitations.',
    })))
    with pytest.raises(repair.RepairFailure, match='MODEL_SUMMARY_INVALID'):
        await repair.derive(row, repair.Evidence('Concrete implementation and measured limitations.',
                                                'article', True), call, fields='summary')
    call.assert_awaited_once()


async def test_sync_records_a_specific_failure_without_repeating_the_model_request():
    generate = AsyncMock(return_value=SimpleNamespace(status='succeeded', output_text='无法生成摘要：' + '只有标题，没有正文。' * 30))
    with pytest.raises(RuntimeError) as error:
        await _generate_brief_with_retry(generate, None, {'title': 'Source'},
                                         'https://example.org/article', timeout_seconds=10)
    assert error.value.error_code == 'REPAIR_SUMMARY_UNAVAILABLE'
    assert _safe_error_code(error.value) == 'REPAIR_SUMMARY_UNAVAILABLE'
    generate.assert_awaited_once()
