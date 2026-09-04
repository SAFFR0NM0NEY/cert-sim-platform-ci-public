import { useCallback, useEffect, useState } from 'react';

export default function useFullscreenMode(targetRef) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState('');
  const fullscreenSupported =
    typeof document !== 'undefined' &&
    document.fullscreenEnabled &&
    typeof document.documentElement.requestFullscreen === 'function';

  useEffect(() => {
    if (!fullscreenSupported) {
      setFullscreenMessage('Fullscreen mode is not supported by this browser.');
      return undefined;
    }

    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === targetRef.current);
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [fullscreenSupported, targetRef]);

  const toggleFullscreen = useCallback(async () => {
    if (!fullscreenSupported || !targetRef.current) {
      return;
    }

    setFullscreenMessage('');

    try {
      if (document.fullscreenElement === targetRef.current) {
        await document.exitFullscreen();
      } else {
        await targetRef.current.requestFullscreen();
      }
    } catch {
      setFullscreenMessage('Fullscreen mode could not be changed.');
    }
  }, [fullscreenSupported, targetRef]);

  return {
    fullscreenMessage,
    fullscreenSupported,
    isFullscreen,
    toggleFullscreen,
  };
}
