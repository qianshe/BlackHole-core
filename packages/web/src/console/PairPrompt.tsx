// A phone scanned the QR code: ask on this computer before it gets access.
// One request at a time, oldest first.
import { useEffect, useRef, useState } from 'react';
import { ApiError, remoteAdmin, type RemotePairRequest } from '../api';
import { DialogHead, Modal, failText, type ToastFn } from './common';
import c from './console.module.css';

const POLL_MS = 2500;

export function PairPrompt({ toast }: { toast: ToastFn }) {
  const [requests, setRequests] = useState<RemotePairRequest[]>([]);
  const [busy, setBusy] = useState(false);
  // closed without answering: stay quiet about it, it expires on its own
  const dismissed = useRef(new Set<string>());

  useEffect(() => {
    // Loopback poll: slow while phone access is off, faster once it is on.
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      remoteAdmin.view().then(
        (v) => {
          if (!alive) return;
          setRequests((v.requests ?? []).filter((r) => !dismissed.current.has(r.id)));
          timer = setTimeout(load, v.enabled ? POLL_MS : POLL_MS * 4);
        },
        () => {
          if (alive) timer = setTimeout(load, POLL_MS * 4);
        },
      );
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const r = requests[0];
  if (!r) return null;
  const answer = (allow: boolean): void => {
    setBusy(true);
    remoteAdmin.decide(r.id, allow).then(
      (v) => {
        setRequests((v.requests ?? []).filter((x) => !dismissed.current.has(x.id)));
        toast(allow ? `已允许「${r.name}」访问` : `已拒绝「${r.name}」`, allow ? 'ok' : undefined);
      },
      (e: unknown) => {
        // answered elsewhere (VS Code) or expired
        setRequests((xs) => xs.filter((x) => x.id !== r.id));
        toast(e instanceof ApiError && e.code === 'request_not_found' ? '这个请求已经处理过或已过期' : failText(e), 'warn');
      },
    ).finally(() => setBusy(false));
  };
  const close = (): void => {
    dismissed.current.add(r.id);
    setRequests((xs) => xs.filter((x) => x.id !== r.id));
  };
  return (
    <Modal key={r.id} label="手机请求访问" onClose={() => !busy && close()}>
      <DialogHead title="手机请求访问" onClose={close} />
      <div className={c.dialogBody}>
        <p>
          <strong>{r.name}</strong> 刚刚扫描了手机访问二维码。
        </p>
        <p>允许后，这台手机可以查看会话、处理审批和新建会话。不是你本人扫的码，请点「拒绝」。</p>
      </div>
      <div className={c.dialogActions}>
        <button type="button" className={c.btn} onClick={() => answer(false)} disabled={busy} autoFocus>
          拒绝
        </button>
        <button type="button" className={c.btnPrimary} onClick={() => answer(true)} disabled={busy}>
          允许
        </button>
      </div>
    </Modal>
  );
}
