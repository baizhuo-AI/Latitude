-- Computer History is a raw evidence source, not one graph node per captured event.
-- Preserve source_records, evidence_refs, and their historical links so the repair
-- remains reversible from the automatic startup backup and traceable afterward.
UPDATE nodes
SET status = 'deleted',
    deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'evidence_event'
  AND origin = 'sensor'
  AND authority = 'source_verified'
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM node_evidence_links nel
    JOIN evidence_refs e ON e.id = nel.evidence_ref_id
    JOIN source_records s ON s.id = e.source_record_id
    WHERE nel.node_id = nodes.id
      AND s.source_type = 'computer_history'
  );

-- Make the conversation surface explicit. A chat record imported from Codex is
-- evidence from that surface, not automatically a Latitude AI conversation.
UPDATE source_records
SET metadata_json = json_set(
      metadata_json,
      '$.conversationContext',
      CASE
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE 'codex-%'
          THEN 'codex_coding_agent'
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE 'latitude-browser-%'
          THEN 'latitude_ai'
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE 'latitude-sanitized-demo%'
          THEN 'demo'
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE '%scheduler%'
          THEN 'latitude_scheduler'
        ELSE 'unknown'
      END,
      '$.sourceLabel',
      CASE
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE 'codex-%'
          THEN 'Codex 编程助手对话'
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE 'latitude-browser-%'
          THEN '维度 AI 对话'
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE 'latitude-sanitized-demo%'
          THEN '演示数据'
        WHEN COALESCE(json_extract(metadata_json, '$.sessionId'), '') LIKE '%scheduler%'
          THEN '维度后台任务'
        ELSE '来源待确认的本地对话'
      END
    )
WHERE source_type = 'chat'
  AND json_type(metadata_json, '$.conversationContext') IS NULL;
