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
export {
  assignSections,
  proposeSections,
  SECTION_ASSIGN_MAX_DISTANCE,
  type SectionRef,
  type GapToPlace,
  type Placement,
  type ProposedSection,
  type SectionNamer,
} from './cluster.js';
