import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { API_URL, getToken } from './api';
import { keys } from './queries';
import type { ChangeNotification } from './types';

export function useProjectStream(projectKey: string, onChange?: (notification: ChangeNotification) => void) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const token = getToken();
    if (!projectKey || !token) return undefined;
    const source = new EventSource(
      `${API_URL}/projects/${projectKey}/stream?access_token=${encodeURIComponent(token)}`,
    );
    source.addEventListener('ready', () => setConnected(true));
    source.addEventListener('change', (event) => {
      const notification = JSON.parse((event as MessageEvent<string>).data) as ChangeNotification;
      void queryClient.invalidateQueries({ queryKey: keys.flags(projectKey) });
      void queryClient.invalidateQueries({ queryKey: keys.changeRequests(projectKey) });
      void queryClient.invalidateQueries({ queryKey: keys.scheduled(projectKey) });
      void queryClient.invalidateQueries({ queryKey: ['audit', projectKey] });
      onChange?.(notification);
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [projectKey, queryClient, onChange]);
  return connected;
}
