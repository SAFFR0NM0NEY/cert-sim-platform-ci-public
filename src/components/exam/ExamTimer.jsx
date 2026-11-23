import { useCallback, useEffect, useRef, useState } from 'react';

export default function ExamTimer({ durationMinutes, expiresAt, initialSeconds, getRemainingSeconds, onTick, onTimeExpired }) {
  const calculateRemaining = useCallback(() => {
    if (getRemainingSeconds) return Math.max(0, getRemainingSeconds());
    const deadline = Date.parse(expiresAt ?? '');
    return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : (initialSeconds ?? durationMinutes * 60);
  }, [durationMinutes, expiresAt, initialSeconds, getRemainingSeconds]);
  const [secondsRemaining, setSecondsRemaining] = useState(calculateRemaining);
  const onTimeExpiredRef = useRef(onTimeExpired);
  onTimeExpiredRef.current = onTimeExpired;
  useEffect(() => {
    let expired = false, intervalId, timeoutId;
    let relative = initialSeconds ?? durationMinutes * 60;
    const tick = () => {
      const absolute = getRemainingSeconds || Number.isFinite(Date.parse(expiresAt ?? ''));
      const next = absolute ? calculateRemaining() : Math.max(0, relative--);
      setSecondsRemaining(next);
      if (next <= 0 && !expired) {
        expired = true;
        window.clearInterval(intervalId);
        timeoutId = window.setTimeout(() => onTimeExpiredRef.current?.(), 0);
      }
    };
    tick();
    if (!expired) intervalId = window.setInterval(tick, 1000);
    return () => { window.clearInterval(intervalId); window.clearTimeout(timeoutId); };
  }, [calculateRemaining, durationMinutes, expiresAt, getRemainingSeconds, initialSeconds]);
  useEffect(() => { onTick?.(secondsRemaining); }, [onTick, secondsRemaining]);
  return <div className={secondsRemaining <= 300 ? 'timer timer-warning' : 'timer'}>
    <span>Time remaining</span><strong>{formatSeconds(secondsRemaining)}</strong>
  </div>;
}

function formatSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
