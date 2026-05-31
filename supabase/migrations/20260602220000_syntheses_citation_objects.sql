-- syntheses.citations shape evolution: number[] → object[] (plan U2)
--
-- Old shape (pre-U2): deduped+sorted ranks only, e.g. [1, 2, 3].
-- New shape (post-U2): per-occurrence objects:
--   [{rank, cardId, position, quote?}, ...]
--
-- The column stays jsonb; only the in-array shape changes. Backfill
-- converts every existing row whose first element is a bare number
-- into the object form:
--
--   for each rank r in citations:
--     emit {
--       rank: r,
--       cardId: source_card_ids[r - 1],   ← lookup
--       position: position(accumulated_text from '[r]'),
--                                          ← Postgres position() returns
--                                            1-based byte offset; we
--                                            subtract 1 to match JS
--                                            String.prototype.indexOf
--       quote: null                        ← no quote available pre-deploy
--     }
--
-- Idempotent: re-running the conversion against an already-object row
-- is a no-op (detected by jsonb_typeof(citations->0) = 'object').
-- Old rows whose citations array is empty are left as-is.
--
-- Rows where source_card_ids[r-1] would be NULL (rank out of range —
-- shouldn't exist in practice, but defensive) skip that rank entirely.

update public.syntheses
set citations = coalesce(
  (
    select jsonb_agg(
      jsonb_build_object(
        'rank', rank_value,
        'cardId', source_card_ids ->> (rank_value - 1),
        'position', greatest(position('[' || rank_value || ']' in accumulated_text) - 1, 0),
        'quote', null
      )
    )
    from (
      select (jsonb_array_elements_text(citations))::int as rank_value
    ) as ranks
    where source_card_ids ->> (rank_value - 1) is not null
  ),
  '[]'::jsonb
)
where jsonb_typeof(citations) = 'array'
  and jsonb_array_length(citations) > 0
  and jsonb_typeof(citations -> 0) = 'number';
