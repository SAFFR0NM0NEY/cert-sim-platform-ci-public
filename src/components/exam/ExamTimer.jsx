import { useEffect, useRef, useState } from 'react';

export default function ExamTimer({ durationMinutes, expiresAt, initialSeconds, onTick, onTimeExpired }) {
  const deadline = Number.isFinite(Date.parse(expiresAt ?? '')) ? Date.parse(expiresAt) : null;
  const calculateRemaining = () => deadline == null ? (initialSeconds ?? durationMinutes * 60) : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const [secondsRemaining, setSecondsRemaining] = useState(calculateRemaining);
  const onTimeExpiredRef = useRef(onTimeExpired);
  const hasExpiredRef = useRef(false);

  useEffect(() => {
    onTimeExpiredRef.current = onTimeExpired;
  }, [onTimeExpired]);

  useEffect(() => {
    const totalSeconds = calculateRemaining();
    setSecondsRemaining(totalSeconds);
    onTick?.(totalSeconds);
    hasExpiredRef.current = false;
  }, [durationMinutes, expiresAt, initialSeconds, onTick]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setSecondsRemaining((currentSeconds) => {
        const nextSeconds = deadline == null ? Math.max(0, currentSeconds - 1) : calculateRemaining();
        if (nextSeconds <= 0) {
          window.clearInterval(intervalId);

          if (!hasExpiredRef.current) {
            hasExpiredRef.current = true;
            window.setTimeout(() => onTimeExpiredRef.current?.(), 0);
          }

          return 0;
        }

        return nextSeconds;
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    onTick?.(secondsRemaining);
  }, [onTick, secondsRemaining]);

  return (
    <div className={secondsRemaining <= 300 ? 'timer timer-warning' : 'timer'}>
      <span>Time remaining</span>
      <strong>{formatSeconds(secondsRemaining)}</strong>
    </div>
  );
}

function formatSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
