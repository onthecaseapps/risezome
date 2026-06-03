/**
 * View models for the Knowledge Gaps UI. The server page maps DB rows to these
 * explicit, JSON-serializable shapes before handing them to the client tree.
 */

export type GapStatus = 'open' | 'resolved' | 'dismissed';

export interface GapOccurrenceView {
  occurrenceId: string;
  meetingId: string;
  utteranceId: string | null;
  verbatimQuestion: string;
  askerName: string;
  askerUserId: string | null;
  askedAtIso: string;
  /** Empty string → rendered as "Untitled meeting". */
  meetingTitle: string;
}

export interface GapView {
  gapId: string;
  sectionId: string | null;
  title: string;
  status: GapStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  frequency: number;
  sharedWithOrg: boolean;
  sectionPinned: boolean;
  reopenedAfterClose: boolean;
  firstAskedAtIso: string | null;
  lastAskedAtIso: string | null;
  assignedByName: string | null;
  assignedAtIso: string | null;
  people: number;
  meetings: number;
  moments: number;
  /** distinct verbatim_question count minus the canonical title (clamped ≥ 0). */
  extraPhrasings: number;
  occurrences: GapOccurrenceView[];
}

export interface SectionView {
  sectionId: string;
  name: string;
  color: string;
  nameLocked: boolean;
}

export interface OrgMember {
  userId: string;
  name: string;
  role: string;
}

export interface NotificationView {
  notificationId: number;
  gapId: string;
  gapTitle: string | null;
  frequency: number;
  actorName: string | null;
}
