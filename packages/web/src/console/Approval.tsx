import { useState, type ReactNode } from 'react';
import { api, type ApprovalScope, type ConfirmationView, type RiskMatch } from '../api';
import { argsPreview, formatTime } from '../format';
import { DialogHead, failText, Modal, useToast } from './common';
import c from './console.module.css';

/** The text the operator is approving: the card command, else the args. */
export function approvalText(x: ConfirmationView): string {
  if (x.command) return x.command;
  const a = x.args as { command?: unknown } | null;
  if (a && typeof a.command === 'string') return a.command;
  return argsPreview(x.args, 2000);
}

/** Command with risk spans marked; overlapping or out-of-range spans are skipped. */
export function markedCommand(text: string, matches: RiskMatch[] | null): ReactNode[] {
  const spans = (matches ?? [])
    .filter((m) => Array.isArray(m.range) && m.range[0] >= 0 && m.range[1] <= text.length && m.range[0] < m.range[1])
    .sort((a, b) => a.range[0] - b.range[0]);
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach((m, i) => {
    if (m.range[0] < at) return;
    if (m.range[0] > at) out.push(text.slice(at, m.range[0]));
    out.push(
      <mark key={i} className={m.tone === 'yellow' ? c.mark_yellow : m.tone === 'blue' ? c.mark_blue : undefined} title={m.label}>
        {text.slice(m.range[0], m.range[1])}
      </mark>,
    );
    at = m.range[1];
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Distinct tags, most severe first. */
export function riskTags(matches: RiskMatch[] | null): RiskMatch[] {
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  const seen = new Set<string>();
  return (matches ?? [])
    .filter((m) => (seen.has(m.label) ? false : (seen.add(m.label), true)))
    .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
}

const critical = (x: ConfirmationView): boolean => (x.risk_matches ?? []).some((m) => m.level === 'critical');

function useResolve(x: ConfirmationView, onDone: () => void): [string | null, (action: 'approve' | 'deny', scope?: ApprovalScope) => void] {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = (action: 'approve' | 'deny', scope?: ApprovalScope): void => {
    setBusy(action + (scope ?? ''));
    api.resolveConfirmation(x.id, action, scope).then(
      () => {
        toast(action === 'deny' ? '已拒绝这次调用' : scope === 'session' ? '已批准，本会话内同类操作不再询问' : '已批准这一次');
        onDone();
      },
      (e: unknown) => {
        toast(failText(e), 'bad');
        setBusy(null);
        onDone();
      },
    );
  };
  return [busy, run];
}

function Tags({ x }: { x: ConfirmationView }) {
  const tags = riskTags(x.risk_matches);
  if (!tags.length) return null;
  return (
    <div className={c.tags}>
      {tags.map((t) => (
        <span key={t.label} className={c[`tag_${t.tone}`] ?? c.tag}>
          {t.label}
        </span>
      ))}
    </div>
  );
}

/** Compact card in the session inspector. */
export function ApprovalCard({ x, onOpen, onDone }: { x: ConfirmationView; onOpen: () => void; onDone: () => void }) {
  const [busy, run] = useResolve(x, onDone);
  const text = approvalText(x);
  return (
    <div className={c.approval}>
      <div className={c.approvalHead}>
        <span className={c.dot_warn} aria-hidden="true" />
        <strong>等待审批</strong>
        <span>{x.tool}</span>
      </div>
      <Tags x={x} />
      <pre className={c.cmd}>{markedCommand(text, x.risk_matches)}</pre>
      <div className={c.approvalActions}>
        <button type="button" className={c.btnPrimary} disabled={!!busy} onClick={() => run('approve', 'once')}>
          批准一次
        </button>
        <button type="button" className={c.btn} disabled={!!busy} onClick={() => run('approve', 'session')}>
          本会话
        </button>
        <button type="button" className={c.btn} onClick={onOpen}>
          详情
        </button>
      </div>
    </div>
  );
}

/** Full approval dialog: tags, highlighted command, scopes, deny. */
export function ApprovalDialog({ x, sessionLabel, onClose, onDone }: { x: ConfirmationView; sessionLabel: string; onClose: () => void; onDone: () => void }) {
  const [busy, run] = useResolve(x, () => {
    onDone();
    onClose();
  });
  const text = approvalText(x);
  const hard = critical(x);
  return (
    <Modal label="审批工具调用" onClose={onClose} className={c.dialog}>
      <DialogHead title="审批工具调用" onClose={onClose} />
      <div className={c.dialogBody}>
        <div className={c.approvalSource}>
          <b>{x.tool}</b> · {sessionLabel}
        </div>
        <Tags x={x} />
        <pre className={c.dialogCmd}>{markedCommand(text, x.risk_matches)}</pre>
        <p className={c.approvalNote}>
          「本会话」：这个会话里同类操作不再询问。{hard ? '包含高风险操作，不能设为始终允许。' : '「始终允许」：所有会话都不再询问，可在设置的授权管理里撤销。'}
        </p>
        {x.expires_at && <p className={c.expires}>{formatTime(x.expires_at)} 前未处理将自动拒绝</p>}
      </div>
      <div className={c.dialogActions}>
        <button type="button" className={c.btnDanger} disabled={!!busy} onClick={() => run('deny')}>
          拒绝
        </button>
        <span className={c.spacer} />
        {!hard && (
          <button type="button" className={c.btnGhost} disabled={!!busy} onClick={() => run('approve', 'always')}>
            始终允许
          </button>
        )}
        <button type="button" className={c.btn} disabled={!!busy} onClick={() => run('approve', 'session')}>
          本会话
        </button>
        <button type="button" className={c.btnPrimary} disabled={!!busy} autoFocus onClick={() => run('approve', 'once')}>
          批准一次
        </button>
      </div>
    </Modal>
  );
}
