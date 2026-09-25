import { useEffect, useRef } from 'react';
import { EventBus } from '@/game/EventBus';
import { createChronicleRefresh, type ChronicleRefreshState } from './chronicleRefresh';

export function useChronicleRefresh(state: ChronicleRefreshState, refresh: (latestDay: boolean) => void) {
  const current = useRef({ state, refresh });
  current.current = { state, refresh };
  useEffect(() => {
    const subscription = createChronicleRefresh(
      () => current.current.state,
      (latestDay) => current.current.refresh(latestDay),
    );
    const onVisibility = () => {
      if (document.visibilityState === 'visible') subscription.onVisible();
    };
    EventBus.on('world-event', subscription.onWorldEvent);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      subscription.dispose();
      EventBus.off('world-event', subscription.onWorldEvent);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
