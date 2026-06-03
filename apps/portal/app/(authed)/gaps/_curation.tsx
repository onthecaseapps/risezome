'use client';

import { useState, useTransition, type ReactElement } from 'react';
import type { GapView, SectionView } from './_types';
import { ChevronDown, DotsGlyph, SectionDot } from './_bits';
import {
  deleteSectionAction,
  mergeGapsAction,
  mergeSectionAction,
  moveAllGapsAction,
  moveGapToSectionAction,
  renameSectionAction,
  splitSectionAction,
} from './section-actions';

/**
 * Manager-only curation surfaces (plan U11 / mockup #10). A per-section ⋮ menu
 * (rename / merge / move-all / delete) and two modal dialogs driven from the
 * client: "Move a gap to a section" and "Merge two gaps". Every action sets the
 * curation pins server-side so the re-clusterer never overrides it (KTD6/AE3).
 */

type Result = { ok: true } | { ok: false; error: string };

// ── section header ⋮ menu ───────────────────────────────────────────────────

export function SectionMenu({
  section,
  otherSections,
  gapCount,
}: {
  section: SectionView;
  otherSections: SectionView[];
  gapCount: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'merge' | 'move' | 'delete' | null>(null);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Section actions"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card hover:text-fg"
      >
        <DotsGlyph />
      </button>
      {open ? (
        <>
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg">
            <MenuItem label="Rename section" onClick={() => { setOpen(false); setDialog('rename'); }} />
            <MenuItem
              label="Merge into another section…"
              disabled={otherSections.length === 0}
              onClick={() => { setOpen(false); setDialog('merge'); }}
            />
            <MenuItem label="Move all gaps…" onClick={() => { setOpen(false); setDialog('move'); }} />
            <MenuItem label="Delete section" danger onClick={() => { setOpen(false); setDialog('delete'); }} />
          </div>
        </>
      ) : null}

      {dialog === 'rename' ? (
        <RenameSectionDialog section={section} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'merge' ? (
        <MergeSectionDialog section={section} targets={otherSections} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'move' ? (
        <MoveAllDialog section={section} targets={otherSections} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteSectionDialog section={section} targets={otherSections} gapCount={gapCount} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-sm disabled:opacity-40 ${
        danger ? 'text-rose-400 hover:bg-rose-500/10' : 'text-fg hover:bg-accent-soft/50'
      }`}
    >
      {label}
    </button>
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function Modal({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-bg p-5 shadow-2xl">{children}</div>
    </div>
  );
}

function useAction(): {
  pending: boolean;
  error: string | null;
  run: (fn: () => Promise<Result>, onDone: () => void) => void;
} {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(fn: () => Promise<Result>, onDone: () => void): void {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) onDone();
      else setError(r.error);
    });
  }
  return { pending, error, run };
}

function RenameSectionDialog({ section, onClose }: { section: SectionView; onClose: () => void }): ReactElement {
  const [name, setName] = useState(section.name);
  const { pending, error, run } = useAction();
  return (
    <Modal>
      <h3 className="text-base font-semibold">Rename section</h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mt-4 w-full rounded-xl border border-border bg-card/60 px-3.5 py-2.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
      />
      <DialogError error={error} />
      <DialogButtons
        onCancel={onClose}
        confirmLabel="Save"
        pending={pending}
        onConfirm={() => run(() => renameSectionAction(section.sectionId, name), onClose)}
      />
    </Modal>
  );
}

function MergeSectionDialog({
  section,
  targets,
  onClose,
}: {
  section: SectionView;
  targets: SectionView[];
  onClose: () => void;
}): ReactElement {
  const [targetId, setTargetId] = useState(targets[0]?.sectionId ?? '');
  const { pending, error, run } = useAction();
  return (
    <Modal>
      <h3 className="text-base font-semibold">Merge “{section.name}” into…</h3>
      <p className="mt-1 text-sm text-muted">Its gaps move to the target section, then “{section.name}” is deleted.</p>
      <SectionPicker targets={targets} value={targetId} onChange={setTargetId} />
      <DialogError error={error} />
      <DialogButtons
        onCancel={onClose}
        confirmLabel="Merge"
        pending={pending}
        disabled={targetId === ''}
        onConfirm={() => run(() => mergeSectionAction(section.sectionId, targetId), onClose)}
      />
    </Modal>
  );
}

function MoveAllDialog({
  section,
  targets,
  onClose,
}: {
  section: SectionView;
  targets: SectionView[];
  onClose: () => void;
}): ReactElement {
  const [targetId, setTargetId] = useState('');
  const { pending, error, run } = useAction();
  return (
    <Modal>
      <h3 className="text-base font-semibold">Move all gaps from “{section.name}”</h3>
      <SectionPicker targets={targets} value={targetId} onChange={setTargetId} allowUncategorized />
      <DialogError error={error} />
      <DialogButtons
        onCancel={onClose}
        confirmLabel="Move gaps"
        pending={pending}
        onConfirm={() => run(() => moveAllGapsAction(section.sectionId, targetId === '' ? null : targetId), onClose)}
      />
    </Modal>
  );
}

function DeleteSectionDialog({
  section,
  targets,
  gapCount,
  onClose,
}: {
  section: SectionView;
  targets: SectionView[];
  gapCount: number;
  onClose: () => void;
}): ReactElement {
  const [targetId, setTargetId] = useState('');
  const { pending, error, run } = useAction();
  const hasGaps = gapCount > 0;
  return (
    <Modal>
      <h3 className="text-base font-semibold">Delete “{section.name}”?</h3>
      {hasGaps ? (
        <>
          <p className="mt-1 text-sm text-muted">
            This section holds {gapCount} {gapCount === 1 ? 'gap' : 'gaps'}. Choose where they should go.
          </p>
          <SectionPicker targets={targets} value={targetId} onChange={setTargetId} allowUncategorized />
        </>
      ) : (
        <p className="mt-1 text-sm text-muted">This section is empty and will be removed.</p>
      )}
      <DialogError error={error} />
      <DialogButtons
        onCancel={onClose}
        confirmLabel="Delete"
        danger
        pending={pending}
        onConfirm={() =>
          run(() => deleteSectionAction(section.sectionId, hasGaps ? (targetId === '' ? null : targetId) : null), onClose)
        }
      />
    </Modal>
  );
}

// ── move-a-gap dialog (opened from a gap row / drawer) ───────────────────────

export function MoveGapDialog({
  gap,
  sections,
  onClose,
}: {
  gap: GapView;
  sections: SectionView[];
  onClose: () => void;
}): ReactElement {
  const [targetId, setTargetId] = useState(gap.sectionId ?? '');
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const { pending, error, run } = useAction();
  return (
    <Modal>
      <h3 className="text-base font-semibold">Move gap to a section</h3>
      <p className="mt-1 truncate text-sm text-muted">{gap.title}</p>
      <div className="mt-4 flex gap-2 text-xs">
        <ModeTab active={mode === 'existing'} onClick={() => setMode('existing')} label="Existing section" />
        <ModeTab active={mode === 'new'} onClick={() => setMode('new')} label="＋ New section" />
      </div>
      {mode === 'existing' ? (
        <SectionPicker
          targets={sections}
          value={targetId}
          onChange={setTargetId}
          allowUncategorized
        />
      ) : (
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New section name"
          className="mt-3 w-full rounded-xl border border-border bg-card/60 px-3.5 py-2.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
      )}
      <DialogError error={error} />
      <DialogButtons
        onCancel={onClose}
        confirmLabel="Move gap"
        pending={pending}
        disabled={mode === 'new' && newName.trim().length === 0}
        onConfirm={() =>
          run(() => {
            if (mode === 'new') return splitSectionAction(newName, [gap.gapId]);
            return moveGapToSectionAction(gap.gapId, targetId === '' ? null : targetId);
          }, onClose)
        }
      />
    </Modal>
  );
}

// ── merge-two-gaps dialog ────────────────────────────────────────────────────

export function MergeGapDialog({
  gap,
  candidates,
  onClose,
}: {
  gap: GapView;
  candidates: GapView[];
  onClose: () => void;
}): ReactElement {
  const [sourceId, setSourceId] = useState('');
  const { pending, error, run } = useAction();
  const source = candidates.find((g) => g.gapId === sourceId) ?? null;
  const combined = gap.frequency + (source?.frequency ?? 0);
  return (
    <Modal>
      <h3 className="text-base font-semibold">Merge 2 gaps?</h3>
      <p className="mt-1 text-sm text-muted">
        Their occurrences and ask-counts combine into one gap. Demand becomes {combined}×. This can&apos;t be undone.
      </p>
      <div className="mt-4 rounded-xl border border-border bg-card/50 p-3 text-sm">
        <span className="text-muted">Keep:</span> <span className="font-medium text-fg">{gap.title}</span>
      </div>
      <label className="mt-3 block text-xs font-medium text-muted">Merge this gap into it:</label>
      <div className="relative mt-1">
        <select
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          className="w-full cursor-pointer appearance-none rounded-xl border border-border bg-card/60 py-2.5 pl-3.5 pr-9 text-sm text-fg focus:border-accent/50 focus:outline-none"
        >
          <option value="">Choose a gap…</option>
          {candidates.map((g) => (
            <option key={g.gapId} value={g.gapId}>
              {g.frequency}× — {g.title}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
      </div>
      <DialogError error={error} />
      <DialogButtons
        onCancel={onClose}
        confirmLabel="Merge gaps"
        danger
        pending={pending}
        disabled={sourceId === ''}
        onConfirm={() => run(() => mergeGapsAction(gap.gapId, sourceId), onClose)}
      />
    </Modal>
  );
}

// ── shared dialog bits ──────────────────────────────────────────────────────

function ModeTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function SectionPicker({
  targets,
  value,
  onChange,
  allowUncategorized = false,
}: {
  targets: SectionView[];
  value: string;
  onChange: (id: string) => void;
  allowUncategorized?: boolean;
}): ReactElement {
  return (
    <div className="relative mt-3">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer appearance-none rounded-xl border border-border bg-card/60 py-2.5 pl-3.5 pr-9 text-sm text-fg focus:border-accent/50 focus:outline-none"
      >
        {allowUncategorized ? <option value="">Uncategorized</option> : <option value="">Choose a section…</option>}
        {targets.map((s) => (
          <option key={s.sectionId} value={s.sectionId}>
            {s.name}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
        {(() => {
          const s = targets.find((t) => t.sectionId === value);
          return s !== undefined ? <SectionDot color={s.color} /> : null;
        })()}
      </span>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

function DialogError({ error }: { error: string | null }): ReactElement | null {
  if (error === null) return null;
  return (
    <p role="alert" className="mt-3 text-sm text-error">
      {error}
    </p>
  );
}

function DialogButtons({
  onCancel,
  onConfirm,
  confirmLabel,
  pending,
  danger = false,
  disabled = false,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  pending: boolean;
  danger?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="mt-5 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={pending || disabled}
        className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50 ${
          danger ? 'bg-rose-500/90' : 'bg-accent text-accent-fg'
        }`}
      >
        {pending ? 'Working…' : confirmLabel}
      </button>
    </div>
  );
}
