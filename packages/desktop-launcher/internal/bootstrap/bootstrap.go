// Package bootstrap locates node and the bundled runtime, runs bootstrap.cjs
// and parses its single bounded LaunchResult line. It never talks to the
// daemon itself: all protocol logic lives in packages/host-runtime.
package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// MaxResultBytes mirrors LAUNCH_RESULT_MAX_BYTES in packages/contracts.
const MaxResultBytes = 16 * 1024

// Receipt is the subset of the ready receipt the launcher shows to the user.
type Receipt struct {
	DaemonVersion string `json:"daemonVersion"`
	LocalURL      string `json:"localUrl"`
}

// Result is one LaunchResult line from bootstrap.cjs.
type Result struct {
	OK            bool     `json:"ok"`
	Code          string   `json:"code,omitempty"`
	Message       string   `json:"message,omitempty"`
	LogPath       string   `json:"logPath,omitempty"`
	BrowserOpened bool     `json:"browserOpened,omitempty"`
	Stopped       bool     `json:"stopped,omitempty"`
	Receipt       *Receipt `json:"receipt,omitempty"`
}

// Runtime is everything needed to run the bootstrap.
type Runtime struct {
	Node        string
	Bootstrap   string
	DaemonEntry string
}

// Env is the lookup surface; tests replace it.
type Env struct {
	Getenv   func(string) string
	LookPath func(string) (string, error)
	Exists   func(string) bool
	ExeDir   string
	Cwd      string
	NodeName string // "node.exe" on Windows, "node" elsewhere
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// DefaultEnv returns the real process environment.
func DefaultEnv() Env {
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		exeDir = filepath.Dir(exe)
	}
	cwd, _ := os.Getwd()
	return Env{Getenv: os.Getenv, LookPath: exec.LookPath, Exists: fileExists, ExeDir: exeDir, Cwd: cwd, NodeName: nodeName}
}

// ErrAssetMissing means node or the bundled runtime could not be found.
var ErrAssetMissing = errors.New("runtime_asset_missing")

// Locate finds node and the runtime files. Order: explicit env overrides,
// a runtime/ directory next to the executable (release layout), then a
// source checkout found by walking up from the executable and cwd (dev).
func Locate(e Env) (Runtime, error) {
	var rt Runtime

	switch {
	case e.Getenv("BLACKHOLE_NODE") != "":
		rt.Node = e.Getenv("BLACKHOLE_NODE")
	case e.ExeDir != "" && e.Exists(filepath.Join(e.ExeDir, "runtime", e.NodeName)):
		rt.Node = filepath.Join(e.ExeDir, "runtime", e.NodeName)
	default:
		if p, err := e.LookPath("node"); err == nil {
			rt.Node = p
		}
	}
	if rt.Node == "" || !e.Exists(rt.Node) {
		return rt, fmt.Errorf("%w: 找不到 Node.js", ErrAssetMissing)
	}

	candidates := [][2]string{}
	if dir := e.Getenv("BLACKHOLE_RUNTIME_DIR"); dir != "" {
		candidates = append(candidates, [2]string{filepath.Join(dir, "bootstrap.cjs"), filepath.Join(dir, "daemon", "cli.js")})
	}
	if e.ExeDir != "" {
		candidates = append(candidates, [2]string{filepath.Join(e.ExeDir, "runtime", "bootstrap.cjs"), filepath.Join(e.ExeDir, "runtime", "daemon", "cli.js")})
	}
	for _, start := range []string{e.ExeDir, e.Cwd} {
		for dir := start; dir != ""; {
			candidates = append(candidates, [2]string{
				filepath.Join(dir, "packages", "host-runtime", "dist", "bootstrap.cjs"),
				filepath.Join(dir, "dist", "cli.js"),
			})
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	for _, c := range candidates {
		if e.Exists(c[0]) && e.Exists(c[1]) {
			rt.Bootstrap, rt.DaemonEntry = c[0], c[1]
			return rt, nil
		}
	}
	return rt, fmt.Errorf("%w: 找不到 BlackHole 运行文件", ErrAssetMissing)
}

// Parse decodes the bootstrap's stdout. Anything oversized or malformed is
// reported as a failed launch instead of being trusted.
func Parse(out []byte) (Result, error) {
	if len(out) > MaxResultBytes {
		return Result{}, errors.New("launch result too large")
	}
	line := bytes.TrimSpace(out)
	if i := bytes.LastIndexByte(line, '\n'); i >= 0 {
		line = bytes.TrimSpace(line[i+1:])
	}
	var r Result
	dec := json.NewDecoder(bytes.NewReader(line))
	if err := dec.Decode(&r); err != nil {
		return Result{}, fmt.Errorf("invalid launch result: %w", err)
	}
	if !r.OK && r.Code == "" {
		return Result{}, errors.New("invalid launch result: missing code")
	}
	if r.OK && !r.Stopped && r.Code != "not_running" && (r.Receipt == nil || r.Receipt.LocalURL == "") {
		return Result{}, errors.New("invalid launch result: missing receipt")
	}
	return r, nil
}

type limitWriter struct {
	buf bytes.Buffer
	n   int
}

func (w *limitWriter) Write(p []byte) (int, error) {
	room := w.n - w.buf.Len()
	if room > 0 {
		if len(p) > room {
			w.buf.Write(p[:room])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}

// Run executes bootstrap.cjs and returns its result.
func Run(ctx context.Context, rt Runtime, extra []string, timeout time.Duration) Result {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := append([]string{rt.Bootstrap, "--daemon-entry", rt.DaemonEntry}, extra...)
	cmd := exec.CommandContext(ctx, rt.Node, args...)
	stdout := &limitWriter{n: MaxResultBytes + 1}
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	hideWindow(cmd)
	runErr := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return Result{Code: "ready_timeout", Message: "启动超时"}
	}
	r, err := Parse(stdout.buf.Bytes())
	if err != nil {
		msg := err.Error()
		if runErr != nil {
			msg = fmt.Sprintf("%s (%v)", msg, runErr)
		}
		return Result{Code: "kernel_exited", Message: msg}
	}
	return r
}
