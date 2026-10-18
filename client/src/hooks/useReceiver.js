import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createReceiverClient } from '../lib/receiverClient.js';
import { createSocket, getSocket } from '../lib/socket.js';

/**
 * Owns one receiver controller for the lifetime of the component.
 * `opts` identity is keyed on its primitive fields so re-renders don't recreate the client.
 */
export function useReceiver({ broadcastId, id, name, language, location, autoPreempt, seed, isolated = false }) {
  const lat = location?.lat;
  const lng = location?.lng;
  const socket = useMemo(() => (broadcastId && isolated ? createSocket() : null), [broadcastId, isolated]);
  useEffect(() => () => socket?.close(), [socket]);

  const client = useMemo(
    () => (broadcastId ? createReceiverClient({ socket: socket ?? getSocket(), broadcastId, id, name, language, location: lat != null ? { lat, lng } : undefined, autoPreempt, seed }) : null),
    // language is applied live via setLanguage, not by rebuilding the client
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [broadcastId, id, name, lat, lng, seed, socket],
  );

  useEffect(() => {
    if (!client) return undefined;
    client.start();
    return () => {
      client.leave();
      client.dispose();
    };
  }, [client]);

  const snapshot = useSyncExternalStore(
    (l) => (client ? client.subscribe(l) : () => {}),
    () => (client ? client.getSnapshot() : EMPTY),
  );
  return { client, state: snapshot };
}

const EMPTY = { status: 'idle', alerts: [], history: [], events: [], feed: [], control: {}, tierSeconds: {}, responded: {} };
