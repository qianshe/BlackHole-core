import { Fragment, useEffect, useRef, useState } from 'react';
import { api, type TurnDiffResponse } from '../api';
import { POLL_MS } from '../usePoll';
import c from './console.module.css';

interface FocusRequest { callId: string; sequence: number }

interface Props {
  sessionId: string;
  active: boolean;
  turnAt: number | null;
  focusRequest: FocusRequest | null;
}

interface Loaded {
  sessionId: string;
  data: TurnDiffResponse;
  requestId: number;
}

export function TurnChanges({ sessionId, active, turnAt, focusRequest }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<{ sessionId: string; path: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ sessionId: string; text: string } | null>(null);
  const [unmatchedFocus, setUnmatchedFocus] = useState<{ sessionId: string; sequence: number } | null>(null);
  const appliedFocus = useRef(0);
  const dismissedFocus = useRef(0);
  const requestSequence = useRef(0);
  const focusBaseline = useRef<{ sequence: number; afterRequest: number } | null>(null);
  const feedTurnIsNewer = turnAt !== null && (loaded?.data.turnAt === null || (loaded?.data.turnAt !== undefined && turnAt > loaded.data.turnAt));
  const data = loaded?.sessionId === sessionId && !feedTurnIsNewer ? loaded.data : null;
  const selectedPath = selected?.sessionId === sessionId ? selected.path : null;
  const selectedFile = data?.files.find((file) => file.path === selectedPath) ?? data?.files[0] ?? null;

  useEffect(() => {
    if (!active || !focusRequest || focusRequest.sequence <= appliedFocus.current || focusRequest.sequence <= dismissedFocus.current) return;
    focusBaseline.current = { sequence: focusRequest.sequence, afterRequest: requestSequence.current };
    setUnmatchedFocus(null);
  }, [active, focusRequest]);

  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    let controller: AbortController | null = null;
    const load = (): void => {
      if (inFlight) return;
      controller = new AbortController();
      const current = controller;
      const requestId = ++requestSequence.current;
      inFlight = true;
      setLoading(true);
      setError(null);
      void api.currentTurnDiff(sessionId, current.signal)
        .then((result) => {
          if (current.signal.aborted) return;
          setLoaded({ sessionId, data: result, requestId });
          setSelected((value) => {
            const currentPath = value?.sessionId === sessionId ? value.path : null;
            return currentPath && result.files.some((file) => file.path === currentPath)
              ? { sessionId, path: currentPath }
              : result.files[0] ? { sessionId, path: result.files[0].path } : null;
          });
        })
        .catch((reason: unknown) => {
          if (!current.signal.aborted) setError({ sessionId, text: reason instanceof Error ? reason.message : '加载本轮修改失败' });
        })
        .finally(() => {
          inFlight = false;
          if (!current.signal.aborted) setLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => { window.clearInterval(timer); controller?.abort(); };
  }, [sessionId, active, turnAt, focusRequest?.sequence]);

  useEffect(() => {
    if (!active || !data || !focusRequest || focusRequest.sequence <= appliedFocus.current || focusRequest.sequence <= dismissedFocus.current) return;
    const baseline = focusBaseline.current;
    if (!baseline || baseline.sequence !== focusRequest.sequence || (loaded?.requestId ?? 0) <= baseline.afterRequest) return;
    const file = data.files.find((item) => item.callIds.includes(focusRequest.callId));
    if (file) {
      setSelected({ sessionId, path: file.path });
      setUnmatchedFocus(null);
      appliedFocus.current = focusRequest.sequence;
    } else if (!loading && data.pending === 0) {
      dismissedFocus.current = focusRequest.sequence;
      setUnmatchedFocus({ sessionId, sequence: focusRequest.sequence });
    }
  }, [active, data, focusRequest, sessionId, loading, loaded]);

  const visibleError = error?.sessionId === sessionId ? error.text : '';
  const waitingForFocus = !!focusRequest && focusRequest.sequence > appliedFocus.current && focusRequest.sequence > dismissedFocus.current;
  const noFocusedDiff = !!focusRequest && unmatchedFocus?.sessionId === sessionId && unmatchedFocus.sequence === focusRequest.sequence;
  const notices = [
    visibleError,
    waitingForFocus ? '正在等待此 Editor 调用对应的文件差异；若操作仍在执行，完成后会自动检查。' : '',
    noFocusedDiff ? '此 Editor 调用没有可验证的本轮文件差异。' : '',
    data?.pending ? `${data.pending} 个编辑操作进行中，完成后更新。` : '',
  ].filter(Boolean);
  const displayedFile = waitingForFocus ? null : selectedFile;
  if (!data && loading) return <div className={c.turnEmpty}>正在读取本轮修改…</div>;
  if (!data && visibleError) return <div className={c.turnEmpty} role="alert">{visibleError}</div>;
  if (!data) return <div className={c.turnEmpty}>本轮暂无文件修改。</div>;
  if (data.turnAt === null) return <div className={c.turnEmpty}>当前会话还没有可识别的已发送消息。</div>;
  if (data.incomplete) return <div className={c.turnEmpty}>本轮编辑记录过多，暂不展示，以免遗漏文件。</div>;

  const countable = data.files.filter((file) => file.status !== 'unavailable');
  const added = countable.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = countable.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const unavailable = data.files.filter((file) => file.status === 'unavailable').length;

  return (
    <div className={c.turnChanges}>
      {notices.length > 0 && (
        <div className={c.turnNotice} role={visibleError ? 'alert' : 'status'}>
          {notices.join(' ')}
        </div>
      )}
      {data.files.length === 0 ? (
        <div className={c.turnEmpty}>{data.pending > 0 ? '等待本轮文件修改完成。' : '本轮暂无文件修改。'}</div>
      ) : (
        <>
          <div className={c.turnStats}>
            <span><b>{data.files.length}</b> 个文件</span>
            <span className={c.turnSpacer} />
            <span className={c.diffAdd}>+{added}</span>
            <span className={c.diffDel}>−{removed}</span>
            {unavailable > 0 && <span className={c.turnUnavailable}>{unavailable} 项未验证</span>}
          </div>
          <div className={c.turnFileHeading}>变更文件</div>
          <div className={c.turnFiles} role="group" aria-label="本轮修改文件">
            {data.files.map((file) => (
              <Fragment key={file.path}>
                <button
                  className={`${c.turnFile} ${selectedFile?.path === file.path ? c.turnFileSelected : ''}`}
                  type="button"
                  aria-pressed={selectedFile?.path === file.path}
                  aria-expanded={displayedFile?.path === file.path}
                  onClick={() => {
                    if (focusRequest) dismissedFocus.current = Math.max(dismissedFocus.current, focusRequest.sequence);
                    setUnmatchedFocus(null);
                    setSelected({ sessionId, path: file.path });
                  }}
                >
                  <span className={c.turnFilePath} title={file.path}>{file.path}</span>
                  {file.status === 'unavailable' ? <span className={c.turnFileUnavailable}>—</span> : (
                    <span className={c.turnFileDelta}>
                      {file.added ? <span className={c.diffAdd}>+{file.added}</span> : null}
                      {file.removed ? <span className={c.diffDel}>−{file.removed}</span> : null}
                    </span>
                  )}
                </button>
                {displayedFile?.path === file.path && (
                  <div className={c.turnDiff}>
                    <div className={c.turnDiffTitle} title={file.path}>{file.path}</div>
                    {file.status === 'ready' ? (
                      <div className={c.turnDiffCode} role="region" aria-label={`${file.path} 的最终差异`}>
                        {file.lines.map((line, index) => line.type === 'hunk' ? (
                          <div key={`${index}-${line.text}`} className={c.turnDiffHunk}>{line.text}</div>
                        ) : (
                          <div key={`${index}-${line.type}`} className={`${c.turnDiffLine} ${line.type === 'add' ? c.turnDiffAdded : line.type === 'remove' ? c.turnDiffRemoved : ''}`}>
                            <span className={c.turnDiffNo}>{line.oldLine ?? ''}</span>
                            <span className={c.turnDiffNo}>{line.newLine ?? ''}</span>
                            <span className={c.turnDiffSign}>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                            <span className={c.turnDiffText}>{line.text}</span>
                          </div>
                        ))}
                      </div>
                    ) : <div className={c.turnUnavailable}>{file.message ?? '此文件暂时无法生成最终差异。'}</div>}
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </>
      )}
      {loading && <div className={c.turnRefreshing}>更新中…</div>}
    </div>
  );
}
