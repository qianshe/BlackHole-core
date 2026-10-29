//go:build windows

// Core handoff helper: operates on ONE kernel process handle after the Manager
// has validated the signed Core identities and recorded an upgrade transaction.
// It refuses an unrelated executable, listener, PID, or missing process.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var tcpProc = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

// MIB_TCPROW_OWNER_PID is 24 bytes, with State/LocalAddr/LocalPort,
// RemoteAddr/RemotePort/OwningPid in order.
func listenerPID(port uint16) (uint32, error) {
	var length uint32
	status, _, _ := tcpProc.Call(0, uintptr(unsafe.Pointer(&length)), 0, 2, 3, 0)
	if status != 122 || length < 4 || length > 2<<20 {
		return 0, errors.New("listener_table_unavailable")
	}
	for i := 0; i < 3; i++ {
		buf := make([]byte, length)
		status, _, _ = tcpProc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&length)), 0, 2, 3, 0)
		if status == 122 && length <= 2<<20 {
			continue
		}
		if status != 0 || len(buf) < 4 {
			return 0, errors.New("listener_table_unavailable")
		}
		n := binary.LittleEndian.Uint32(buf[:4])
		if int(n) > (len(buf)-4)/24 {
			return 0, errors.New("listener_table_invalid")
		}
		var result uint32
		for j := uint32(0); j < n; j++ {
			row := buf[4+int(j)*24 : 4+(int(j)+1)*24]
			if binary.LittleEndian.Uint32(row[:4]) != 2 || binary.BigEndian.Uint16(row[8:10]) != port {
				continue
			}
			if row[4] != 127 || row[5] != 0 || row[6] != 0 || row[7] != 1 {
				continue
			}
			pid := binary.LittleEndian.Uint32(row[20:24])
			if result != 0 && result != pid {
				return 0, errors.New("listener_identity_ambiguous")
			}
			result = pid
		}
		if result == 0 {
			return 0, errors.New("listener_not_found")
		}
		return result, nil
	}
	return 0, errors.New("listener_table_unavailable")
}

type expectedIdentity struct {
	daemonID, fingerprint, descriptorHash, dataRootID string
}

func verifyDaemon(port uint16, expected expectedIdentity) error {
	if expected.daemonID == "" || expected.fingerprint == "" || len(expected.descriptorHash) != 64 || len(expected.dataRootID) != 64 {
		return errors.New("handoff_identity_invalid")
	}
	client := &http.Client{Timeout: 2500 * time.Millisecond,
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect_forbidden") }}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", port))
	if err != nil {
		return errors.New("handoff_health_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("handoff_health_unavailable")
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(bytes) > 256*1024 {
		return errors.New("handoff_health_invalid")
	}
	var body struct {
		OK          bool   `json:"ok"`
		DaemonID    string `json:"daemon_id"`
		Fingerprint string `json:"start_fingerprint"`
		Hash        string `json:"descriptor_hash"`
		Root        string `json:"data_root_id"`
		State       string `json:"lifecycle_state"`
	}
	if json.Unmarshal(bytes, &body) != nil || !body.OK || body.State != "managed" ||
		body.DaemonID != expected.daemonID || body.Fingerprint != expected.fingerprint ||
		body.Hash != expected.descriptorHash || body.Root != expected.dataRootID {
		return errors.New("handoff_health_identity_mismatch")
	}
	return nil
}

func execute(pid uint32, port uint16, exe string, expected expectedIdentity, verifyOnly bool) error {
	if pid < 4 || port < 1024 || !filepath.IsAbs(exe) {
		return errors.New("handoff_arguments_invalid")
	}
	handle, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, pid)
	if e != nil {
		return errors.New("handoff_process_unavailable")
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size) != nil ||
		!strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(exe)) {
		return errors.New("handoff_executable_mismatch")
	}
	if e := verifyDaemon(port, expected); e != nil {
		return e
	}
	actual, e := listenerPID(port)
	if e != nil {
		return e
	}
	if actual != pid {
		return errors.New("handoff_listener_mismatch")
	}
	if verifyOnly {
		return nil
	}
	if windows.TerminateProcess(handle, 1) != nil {
		return errors.New("handoff_exit_unconfirmed")
	}
	state, e := windows.WaitForSingleObject(handle, 10000)
	if e != nil || state != windows.WAIT_OBJECT_0 {
		return errors.New("handoff_exit_unconfirmed")
	}
	return nil
}
func main() {
	pid := flag.Uint("pid", 0, "verified PID")
	port := flag.Uint("port", 0, "verified loopback port")
	exe := flag.String("exe", "", "verified executable")
	daemon := flag.String("daemon", "", "expected daemon ID")
	fingerprint := flag.String("fingerprint", "", "expected start fingerprint")
	hash := flag.String("hash", "", "expected descriptor hash")
	root := flag.String("data-root", "", "expected data root identity")
	verifyOnly := flag.Bool("verify", false, "read-only identity check")
	flag.Parse()
	if flag.NArg() != 0 || *pid > 0xffffffff || *port > 65535 ||
		execute(uint32(*pid), uint16(*port), *exe, expectedIdentity{*daemon, *fingerprint, *hash, *root}, *verifyOnly) != nil {
		os.Exit(3)
	}
	state := "stopped"
	if *verifyOnly {
		state = "verified"
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "state": state})
}
