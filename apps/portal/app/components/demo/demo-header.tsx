/**
 * The HUD header strip: a pulsing LIVE badge and the meeting label, mirroring
 * apps/hud/index.html #hud-header + styles.css .status-live.
 */
export function DemoHeader({ meetingLabel }: { meetingLabel: string }): React.ReactElement {
  return (
    <div className="hud-header">
      <span className="status status-live">LIVE</span>
      <span className="hud-meeting-label">{meetingLabel}</span>
    </div>
  );
}
