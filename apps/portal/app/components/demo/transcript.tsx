import type { TranscriptLine } from './types';

/**
 * The streaming transcript panel. The most recent line can show a typing
 * caret while it's still being "spoken" (U6 drives `activeLineTyping`).
 */
export function Transcript({
  lines,
  activeLineTyping = false,
}: {
  lines: readonly TranscriptLine[];
  activeLineTyping?: boolean;
}): React.ReactElement {
  return (
    <div className="transcript" aria-label="Live transcript">
      <div className="transcript-label">Transcript</div>
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1;
        return (
          <p key={line.id} className="transcript-line">
            <span className="speaker">{line.speaker}:</span> {line.text}
            {isLast && activeLineTyping && (
              <span className="transcript-caret" aria-hidden="true" />
            )}
          </p>
        );
      })}
    </div>
  );
}
