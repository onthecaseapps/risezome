CREATE VIRTUAL TABLE IF NOT EXISTS vec_doc_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[1024]
);
