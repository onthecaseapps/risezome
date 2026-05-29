export type CardTrigger = 'window' | 'question' | 'question-provisional';

export interface CardEvent {
  readonly cardId: string;
  readonly docId: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
  readonly surfacedAt: number;
  readonly triggeredBy: CardTrigger;
  readonly utteranceId?: string;
  readonly traceId: string;
}

export interface CardUpdated {
  readonly cardId: string;
  readonly score?: number;
  readonly triggeredBy?: CardTrigger;
  readonly metadata?: Record<string, unknown>;
}

export interface CardRetracted {
  readonly cardId: string;
  readonly reason: 'verifier-downgraded' | 'meeting-ended' | 'manual-dismiss';
}

export interface RetrievalTrace {
  readonly traceId: string;
  readonly utteranceId?: string;
  readonly windowFlushAt: number;
  readonly embedStartAt: number;
  readonly embedEndAt: number;
  readonly retrieveStartAt: number;
  readonly retrieveEndAt: number;
  readonly cardEmitAt: number;
  readonly cardCount: number;
}

export interface RetrievalPipelineEvents {
  card: [CardEvent];
  cardUpdated: [CardUpdated];
  cardRetracted: [CardRetracted];
  trace: [RetrievalTrace];
  error: [Error];
}
