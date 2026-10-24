package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"blackhole/desktop-launcher/internal/coremanager"
)

// maintenanceManager is the Manager surface native maintenance may use. A Web
// page, tray click or window click is never forwarded as confirmation: the
// coordinator re-checks the target and asks natively before calling Maintain.
type maintenanceManager interface {
	Maintain(ctx context.Context, host coremanager.Host, prior coremanager.Attachment, port int, operation, id string, confirmed bool, revision *int) (coremanager.MaintenanceResult, error)
	InspectMaintenances(ctx context.Context) ([]coremanager.MaintenanceRecord, error)
	ReconcileMaintenance(ctx context.Context, id, fingerprint string, confirmed bool) error
	InspectStart(ctx context.Context) (*coremanager.StartState, error)
}

type nativePrompts interface {
	Confirm(title, text string) bool
	Info(title, text string)
	Error(title, text string)
}

type nativePromptsImpl struct{}

func (nativePromptsImpl) Confirm(title, text string) bool { return showConfirm(title, text) }
func (nativePromptsImpl) Info(title, text string)         { showInfo(title, text) }
func (nativePromptsImpl) Error(title, text string)        { showError(title, text) }

// maintenanceHooks adapt the coordinator to the hosting native process. The
// tray hosts a separate window process; the window hosts the Web page. Each
// initiator coordinates only processes belonging to this Desktop shell.
type maintenanceHooks struct {
	// PreparePeers runs after native confirmation and with our own keeper
	// already paused. It must not touch other clients' leases.
	PreparePeers func(ctx context.Context, fingerprint string) error
	OnStopped    func()
	OnRestarted  func(next coremanager.Attachment)
	// OnReleasedForRecovery runs after this process detached its own lease
	// for a dead-target recovery, whether recovery succeeded or not: the
	// native UI must be reopened explicitly before it owns a lease again.
	OnReleasedForRecovery func()
}

var maintenanceRefusals = map[string]bool{
	"active_clients": true, "active_work": true, "active_requests": true,
	"active_handlers": true, "active_processes": true, "active_connections": true,
	"settings_revision_conflict": true, "core_update_required": true,
	"client_update_required": true, "manager_key_mismatch": true,
	"lock_busy": true, "lease_expired": true, "lease_missing": true,
	"maintenance_target_mismatch": true, "endpoint_revision_conflict": true,
}

// maintenanceCoordinator serializes native maintenance for one native
// process. Unknown outcomes are sticky: no automatic retry, no resumed
// heartbeat, and the next attempt is refused until the transaction has been
// inspected through RunInspect.
type maintenanceCoordinator struct {
	client  maintenanceManager
	keeper  *leaseKeeper
	prompts nativePrompts
	hooks   maintenanceHooks
	newID   func() string

	peerTimeout  time.Duration
	pollInterval time.Duration

	mu      sync.Mutex
	busy    bool
	unknown string
}

func newMaintenanceCoordinator(client maintenanceManager, keeper *leaseKeeper, prompts nativePrompts, hooks maintenanceHooks) *maintenanceCoordinator {
	return &maintenanceCoordinator{client: client, keeper: keeper, prompts: prompts, hooks: hooks, newID: instanceID, peerTimeout: 10 * time.Second, pollInterval: 100 * time.Millisecond}
}

func (c *maintenanceCoordinator) tryBegin() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.busy {
		return false
	}
	c.busy = true
	return true
}

func (c *maintenanceCoordinator) end() {
	c.mu.Lock()
	c.busy = false
	c.mu.Unlock()
}

func (c *maintenanceCoordinator) unknownRequest() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.unknown
}

// Run executes one confirmed stop/restart against the exact incarnation this
// process attached to. It reports whether the operation completed; a false
// result is never presented as success by callers.
func (c *maintenanceCoordinator) Run(ctx context.Context, operation string, revision *int) bool {
	return c.run(ctx, operation, revision, false)
}

// StopForUpdate uses the exact same confirmation, keeper, busy/unknown state
// and Manager guard, but retains the tray until the external installer helper
// has been launched. It never force-stops other clients or clears journals.
func (c *maintenanceCoordinator) StopForUpdate(ctx context.Context) bool {
	return c.run(ctx, "stop", nil, true)
}
func (c *maintenanceCoordinator) run(ctx context.Context, operation string, revision *int, forUpdate bool) bool {
	if operation != "stop" && operation != "restart" {
		c.prompts.Error("BlackHole", "maintenance_request_invalid：维护操作类型不被识别，未执行。")
		return false
	}
	if revision != nil && (operation != "restart" || *revision < 0) {
		c.prompts.Error("BlackHole", "settings_revision_invalid：配置版本号缺失或不合法，未执行。")
		return false
	}
	if !c.tryBegin() {
		c.prompts.Error("BlackHole", "maintenance_in_progress：已有维护操作正在进行，未重复发送。")
		return false
	}
	defer c.end()
	if id := c.unknownRequest(); id != "" {
		c.prompts.Error("BlackHole", fmt.Sprintf("maintenance_outcome_requires_inspection：事务 %s 结果未确认。请先使用“检查/恢复维护事务”，不要重复操作。", id))
		return false
	}
	attachment := c.keeper.current()
	target := attachment.Receipt
	// Target binding is re-checked natively; a stale tray/window never acts
	// on a replacement incarnation it did not attach to.
	record, err := c.client.InspectStart(ctx)
	if err != nil || record == nil || record.Status != "ready" || record.Receipt == nil || record.StartFingerprint != target.StartFingerprint || record.Receipt.DaemonID != target.DaemonID || record.Port != c.keeper.port {
		c.prompts.Error("BlackHole", "maintenance_target_changed：当前 Core 与本窗口附着的实例不一致，未发送维护请求。")
		return false
	}
	label := "停止"
	if operation == "restart" {
		label = "重启"
	}
	text := fmt.Sprintf("确定要%s共享 Core 吗？\n\n版本：%s\n端口：%d\n\n本机 Desktop 的窗口将关闭；其他客户端或正在进行的工作会阻止操作，不会强制中断。确认期间目标发生变化会拒绝执行。", label, target.DaemonVersion, c.keeper.port)
	if revision != nil {
		text = fmt.Sprintf("应用已保存的配置版本 %d 并重启共享 Core 吗？\n\n版本：%s\n端口：%d\n\n本机 Desktop 的窗口将关闭；其他客户端或正在进行的工作会阻止操作。确认期间配置或目标发生变化会拒绝执行。", *revision, target.DaemonVersion, c.keeper.port)
	}
	if !c.prompts.Confirm("BlackHole", text) {
		return false
	}
	c.keeper.pause()
	if c.hooks.PreparePeers != nil {
		if err := c.hooks.PreparePeers(ctx, target.StartFingerprint); err != nil {
			c.keeper.resume()
			c.prompts.Error("BlackHole", err.Error())
			return false
		}
	}
	requestID := c.newID()
	result, err := c.client.Maintain(ctx, c.keeper.host, attachment, c.keeper.port, operation, requestID, true, revision)
	if err != nil {
		code := maintenanceErrorCode(err)
		if maintenanceRefusals[code] {
			c.keeper.resume()
			c.prompts.Error("BlackHole", fmt.Sprintf("%s：操作被明确拒绝，Core 未被停止或重启。未自动重试。", code))
			return false
		}
		c.mu.Lock()
		c.unknown = requestID
		c.mu.Unlock()
		c.prompts.Error("BlackHole", fmt.Sprintf("maintenance_outcome_requires_inspection：事务 %s 结果未确认。请先检查维护事务，不要重复操作。", requestID))
		return false
	}
	if operation == "stop" {
		c.keeper.markConsumed()
		if forUpdate {
			return true
		}
		c.prompts.Info("BlackHole", "共享 Core 已停止。本机 Desktop 客户端已解绑；数据和 Core 文件保留。")
		if c.hooks.OnStopped != nil {
			c.hooks.OnStopped()
		}
		return true
	}
	if result.Attachment == nil {
		c.mu.Lock()
		c.unknown = requestID
		c.mu.Unlock()
		c.prompts.Error("BlackHole", fmt.Sprintf("maintenance_outcome_requires_inspection：事务 %s 未返回新实例回执。请先检查维护事务。", requestID))
		return false
	}
	if err := c.keeper.adopt(*result.Attachment); err != nil {
		c.mu.Lock()
		c.unknown = requestID
		c.mu.Unlock()
		c.prompts.Error("BlackHole", "maintenance_target_changed：新实例回执与本客户端不一致，已停止自动操作。请重新打开 BlackHole 核对。")
		return false
	}
	c.keeper.resume()
	if c.hooks.OnRestarted != nil {
		c.hooks.OnRestarted(*result.Attachment)
	}
	return true
}

// RunInspect handles the oldest pending transaction with native selection
// between dead-target recovery and explicitly accepting a verified live
// replacement. It never kills, starts or silently restarts Core.
func (c *maintenanceCoordinator) RunInspect(ctx context.Context) bool {
	if !c.tryBegin() {
		c.prompts.Error("BlackHole", "maintenance_in_progress：已有维护操作正在进行。")
		return false
	}
	defer c.end()
	records, err := c.client.InspectMaintenances(ctx)
	if err != nil {
		c.prompts.Error("BlackHole", fmt.Sprintf("%s：读取维护事务列表失败，请稍后重试。", maintenanceErrorCode(err)))
		return false
	}
	if len(records) == 0 {
		c.prompts.Info("BlackHole", "没有未解决的维护事务。")
		return true
	}
	record := records[0]
	extra := ""
	if len(records) > 1 {
		extra = fmt.Sprintf("\n\n另有 %d 个未解决事务；处理完本事务后请再次检查。", len(records)-1)
	}
	current, _ := c.client.InspectStart(ctx)
	accept := record.Operation == "restart" && current != nil && current.Status == "ready" && current.StartFingerprint != "" && current.StartFingerprint != record.Target.StartFingerprint
	if accept {
		if !c.prompts.Confirm("BlackHole", fmt.Sprintf("事务 %s（%s · %s）有一个已就绪的新实例。\n\n仅接纳该已验证实例，不代表原配置申请已经生效；不会停止进程或修改配置。%s", record.RequestID, record.Operation, record.State, extra)) {
			return false
		}
		if !c.prompts.Confirm("BlackHole", "再次确认：只接纳当前已验证的新实例。完成后请重新连接并核对设置。") {
			return false
		}
		if err := c.client.ReconcileMaintenance(ctx, record.RequestID, current.StartFingerprint, true); err != nil {
			c.prompts.Error("BlackHole", fmt.Sprintf("%s：接纳新实例未完成，事务保持未解决状态；请再次使用“检查／恢复维护事务”。", maintenanceErrorCode(err)))
			return false
		}
		c.clearUnknown(record.RequestID)
		c.prompts.Info("BlackHole", "维护事务已按“接纳新实例”恢复，未启动或停止 Core。请重新连接并核对配置。")
		return true
	}
	if !c.prompts.Confirm("BlackHole", fmt.Sprintf("检查事务 %s（%s · %s）？\n\n恢复只会在目标已退出且没有其他租约时归档事务。本机 Desktop 客户端将先解绑并关闭；不会强杀、自动重启或删除其他实例的记录。%s", record.RequestID, record.Operation, record.State, extra)) {
		return false
	}
	c.keeper.pause()
	if c.hooks.PreparePeers != nil {
		_ = c.hooks.PreparePeers(ctx, record.Target.StartFingerprint)
	}
	// Dead-target recovery requires no live leases, including our own.
	c.keeper.release()
	err = c.client.ReconcileMaintenance(ctx, record.RequestID, "", true)
	if err != nil {
		c.prompts.Error("BlackHole", fmt.Sprintf("%s：恢复维护事务未完成；本机客户端已解绑，请重新打开 BlackHole 后再次检查。", maintenanceErrorCode(err)))
	} else {
		c.clearUnknown(record.RequestID)
		c.prompts.Info("BlackHole", "维护事务已恢复，本操作未启动 Core。需要使用时请重新打开 BlackHole。")
	}
	if c.hooks.OnReleasedForRecovery != nil {
		c.hooks.OnReleasedForRecovery()
	}
	return err == nil
}

func (c *maintenanceCoordinator) clearUnknown(id string) {
	c.mu.Lock()
	if c.unknown == id {
		c.unknown = ""
	}
	c.mu.Unlock()
}

func maintenanceErrorCode(err error) string {
	var managerErr *coremanager.ManagerError
	if errors.As(err, &managerErr) && managerErr.Code != "" {
		return managerErr.Code
	}
	var unknown *coremanager.UnknownOutcome
	if errors.As(err, &unknown) {
		return "maintenance_outcome_unknown"
	}
	if err != nil && len(err.Error()) <= 120 {
		return err.Error()
	}
	return "managed_operation_failed"
}

// --- Desktop peer lease-release coordination -------------------------------
//
// The tray and the window are separate processes that each own a lease. When
// one of them initiates maintenance, the other Desktop process must release
// only its own lease; the Manager still refuses if any third client remains.
// Coordination uses two small files in the per-port Desktop state directory:
// a request bound to the exact start fingerprint, and its acknowledgement.
// Stale or mismatched requests are ignored and removed.

type leaseReleaseRequest struct {
	Nonce       string `json:"nonce"`
	Fingerprint string `json:"fingerprint"`
	ExpiresAt   string `json:"expiresAt"`
}

type peerReleaseStore struct{ dir string }

func (s peerReleaseStore) requestPath() string {
	return filepath.Join(s.dir, "lease-release-request.json")
}
func (s peerReleaseStore) ackPath() string { return filepath.Join(s.dir, "lease-release-ack.json") }

func writeJSONFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

// request asks the peer Desktop process to release its lease for this exact
// incarnation and waits for its acknowledgement. A timeout is an explicit
// coordination failure, never permission to bypass the peer's lease.
func (s peerReleaseStore) request(ctx context.Context, fingerprint string, timeout time.Duration) error {
	if s.dir == "" || fingerprint == "" {
		return errors.New("peer_release_unavailable")
	}
	nonce := instanceID()
	_ = os.Remove(s.ackPath())
	req := leaseReleaseRequest{Nonce: nonce, Fingerprint: fingerprint, ExpiresAt: time.Now().Add(2 * time.Minute).Format(time.RFC3339Nano)}
	if err := writeJSONFile(s.requestPath(), req); err != nil {
		return errors.New("peer_release_unavailable")
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(s.ackPath()); err == nil {
			var ack leaseReleaseRequest
			if json.Unmarshal(data, &ack) == nil && ack.Nonce == nonce && ack.Fingerprint == fingerprint {
				_ = os.Remove(s.requestPath())
				_ = os.Remove(s.ackPath())
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return errors.New("peer_release_cancelled")
		case <-time.After(100 * time.Millisecond):
		}
	}
	return errors.New("peer_release_timeout：另一 Desktop 界面未确认释放其租约，未绕过活动检查。")
}

// pending returns a live, unexpired release request, removing stale files.
func (s peerReleaseStore) pending() (*leaseReleaseRequest, error) {
	data, err := os.ReadFile(s.requestPath())
	if err != nil {
		return nil, nil
	}
	var req leaseReleaseRequest
	if json.Unmarshal(data, &req) != nil || req.Nonce == "" || req.Fingerprint == "" {
		_ = os.Remove(s.requestPath())
		return nil, nil
	}
	expires, err := time.Parse(time.RFC3339Nano, req.ExpiresAt)
	if err != nil || time.Now().After(expires) {
		_ = os.Remove(s.requestPath())
		return nil, nil
	}
	return &req, nil
}

func (s peerReleaseStore) acknowledge(req leaseReleaseRequest) error {
	if err := writeJSONFile(s.ackPath(), req); err != nil {
		return err
	}
	_ = os.Remove(s.requestPath())
	return nil
}

func (s peerReleaseStore) presencePath() string {
	return filepath.Join(s.dir, "tray-presence.json")
}

// announcePresence lets the window process distinguish "tray is running and
// holds a lease for this incarnation" from "no tray". Presence is advisory
// only; the Manager remains the authority on live leases.
func (s peerReleaseStore) announcePresence(fingerprint string) {
	s.announcePresenceWithInstance(fingerprint, "tray")
}

func (s peerReleaseStore) announcePresenceWithInstance(fingerprint, instanceID string) {
	if s.dir == "" || fingerprint == "" {
		return
	}
	if instanceID == "" {
		instanceID = "tray"
	}
	_ = writeJSONFile(s.presencePath(), leaseReleaseRequest{Nonce: instanceID, Fingerprint: fingerprint, ExpiresAt: time.Now().Add(6 * time.Second).Format(time.RFC3339Nano)})
}

func (s peerReleaseStore) clearPresence() {
	if s.dir != "" {
		_ = os.Remove(s.presencePath())
	}
}

func (s peerReleaseStore) presence() (string, bool) {
	fp, _, ok := s.presenceInstance()
	return fp, ok
}

func (s peerReleaseStore) presenceInstance() (string, string, bool) {
	data, err := os.ReadFile(s.presencePath())
	if err != nil {
		return "", "", false
	}
	var presence leaseReleaseRequest
	if json.Unmarshal(data, &presence) != nil || presence.Fingerprint == "" {
		return "", "", false
	}
	expires, err := time.Parse(time.RFC3339Nano, presence.ExpiresAt)
	if err != nil || time.Now().After(expires) {
		return "", "", false
	}
	return presence.Fingerprint, presence.Nonce, true
}

type sharedAttachmentNotice struct {
	Attachment coremanager.Attachment `json:"attachment"`
	ExpiresAt  string                 `json:"expiresAt"`
}

func (s peerReleaseStore) attachmentPath() string {
	return filepath.Join(s.dir, "shared-attachment.json")
}

func (s peerReleaseStore) stopNoticePath() string {
	return filepath.Join(s.dir, "shared-stopped.json")
}

func (s peerReleaseStore) publishAttachment(att coremanager.Attachment) {
	if s.dir == "" || att.Lease.LeaseID == "" {
		return
	}
	_ = writeJSONFile(s.attachmentPath(), sharedAttachmentNotice{
		Attachment: att,
		ExpiresAt:  time.Now().Add(30 * time.Second).Format(time.RFC3339Nano),
	})
}

func (s peerReleaseStore) consumeAttachment() (coremanager.Attachment, bool) {
	if s.dir == "" {
		return coremanager.Attachment{}, false
	}
	data, err := os.ReadFile(s.attachmentPath())
	if err != nil {
		return coremanager.Attachment{}, false
	}
	_ = os.Remove(s.attachmentPath())
	var notice sharedAttachmentNotice
	if json.Unmarshal(data, &notice) != nil || notice.Attachment.Lease.LeaseID == "" {
		return coremanager.Attachment{}, false
	}
	expires, err := time.Parse(time.RFC3339Nano, notice.ExpiresAt)
	if err != nil || time.Now().After(expires) {
		return coremanager.Attachment{}, false
	}
	return notice.Attachment, true
}

func (s peerReleaseStore) publishStop(fingerprint string) {
	if s.dir == "" || fingerprint == "" {
		return
	}
	_ = writeJSONFile(s.stopNoticePath(), leaseReleaseRequest{
		Nonce:       "stopped",
		Fingerprint: fingerprint,
		ExpiresAt:   time.Now().Add(30 * time.Second).Format(time.RFC3339Nano),
	})
}

func (s peerReleaseStore) consumeStop(fingerprint string) bool {
	if s.dir == "" || fingerprint == "" {
		return false
	}
	data, err := os.ReadFile(s.stopNoticePath())
	if err != nil {
		return false
	}
	var notice leaseReleaseRequest
	if json.Unmarshal(data, &notice) != nil || notice.Fingerprint == "" {
		_ = os.Remove(s.stopNoticePath())
		return false
	}
	expires, err := time.Parse(time.RFC3339Nano, notice.ExpiresAt)
	if err != nil || time.Now().After(expires) {
		_ = os.Remove(s.stopNoticePath())
		return false
	}
	if notice.Fingerprint != fingerprint {
		return false
	}
	_ = os.Remove(s.stopNoticePath())
	return true
}
