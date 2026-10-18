import { useCallback, useEffect, useReducer, useRef } from 'react';
import { getSocket, emitAck } from '../lib/socket.js';

const initial = { status: 'idle', receivers: {}, events: [], messages: {}, deliveries: {}, acks: [], relays: [], error: null };
const cap = (arr, n) => arr.slice(0, n);

function reducer(s, a) {
  switch (a.type) {
    case 'reset':
      return { ...initial, status: 'connecting' };
    case 'joined':
      return { ...s, status: 'live', error: null, receivers: Object.fromEntries(a.receivers.map((r) => [r.id, r])) };
    case 'error':
      return { ...s, status: 'error', error: a.error };
    case 'offline':
      return { ...s, status: 'reconnecting' };
    case 'receiver':
      return { ...s, receivers: { ...s.receivers, [a.r.id]: { ...(s.receivers[a.r.id] ?? {}), ...a.r } } };
    case 'left': {
      const { [a.id]: _gone, ...rest } = s.receivers;
      return { ...s, receivers: rest };
    }
    case 'status':
      return s.receivers[a.id] ? { ...s, receivers: { ...s.receivers, [a.id]: { ...s.receivers[a.id], connection: a.connection } } } : s;
    case 'quality':
      return { ...s, events: cap([a.e, ...s.events], 60) };
    case 'message':
      return { ...s, messages: { ...s.messages, [a.m.id]: { ...(s.messages[a.m.id] ?? {}), ...a.m } } };
    case 'superseded':
      return s.messages[a.oldId] ? { ...s, messages: { ...s.messages, [a.oldId]: { ...s.messages[a.oldId], supersededBy: a.newId } } } : s;
    case 'delivery': {
      const key = a.d.messageId;
      return { ...s, deliveries: { ...s.deliveries, [key]: { ...(s.deliveries[key] ?? {}), [a.d.receiverId]: { ...(s.deliveries[key]?.[a.d.receiverId] ?? {}), ...a.d } } } };
    }
    case 'ack':
      return { ...s, acks: cap([a.a, ...s.acks], 100) };
    case 'relay':
      return { ...s, relays: cap([a.r, ...s.relays], 30) };
    default:
      return s;
  }
}

/** Live operations view of one broadcast: receivers, quality changes, deliveries, acks. */
export function useOps(broadcastId) {
  const [state, dispatch] = useReducer(reducer, initial);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!broadcastId) return undefined;
    const socket = getSocket();
    socketRef.current = socket;
    dispatch({ type: 'reset' });

    const join = () =>
      emitAck(socket, 'ops:join', { broadcastId })
        .then((res) => dispatch({ type: 'joined', receivers: res.receivers }))
        .catch((e) => dispatch({ type: 'error', error: e.message }));

    const h = {
      'receiver:joined': (r) => r.broadcastId === broadcastId && dispatch({ type: 'receiver', r }),
      'receiver:state': (r) => r.broadcastId === broadcastId && dispatch({ type: 'receiver', r }),
      'receiver:left': ({ id }) => dispatch({ type: 'left', id }),
      'receiver:status': ({ id, connection }) => dispatch({ type: 'status', id, connection }),
      'quality:changed': (e) => dispatch({ type: 'quality', e }),
      'emergency:created': (m) => dispatch({ type: 'message', m }),
      'alert:superseded': (p) => dispatch({ type: 'superseded', ...p }),
      'delivery:updated': (d) => dispatch({ type: 'delivery', d }),
      'ack:created': (a) => dispatch({ type: 'ack', a }),
      'mesh:relay': (r) => dispatch({ type: 'relay', r: { ...r, at: Date.now(), kind: 'MESH' } }),
      'sms:simulated': (r) => dispatch({ type: 'relay', r: { ...r, at: Date.now(), kind: 'SMS' } }),
      connect: join,
      disconnect: () => dispatch({ type: 'offline' }),
    };
    Object.entries(h).forEach(([e, fn]) => socket.on(e, fn));
    if (socket.connected) join();
    return () => {
      Object.entries(h).forEach(([e, fn]) => socket.off(e, fn));
      socket.emit('ops:leave', { broadcastId });
    };
  }, [broadcastId]);

  const control = useCallback(
    (receiverId, command) => emitAck(socketRef.current ?? getSocket(), 'network:control', { broadcastId, receiverId, command }),
    [broadcastId],
  );

  return { ...state, control };
}
