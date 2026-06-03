export type { MissReason, MissRecord } from './contract.js';
export { shouldRecordMiss } from './capture.js';
export {
  cosineDistance,
  meanVector,
  dedupeWithinBatch,
  findMergeTarget,
  GAP_MERGE_MAX_DISTANCE,
  type Embedded,
  type DedupGroup,
  type GapCandidate,
} from './merge.js';
