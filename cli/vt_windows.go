//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// enableColor turns on ANSI colors in a Windows console (off by default in the classic
// console host, which otherwise prints them as ←[31m). False when that's not possible.
func enableColor(f *os.File) bool {
	const enableVirtualTerminalProcessing = 0x0004
	k := syscall.NewLazyDLL("kernel32.dll")
	getMode, setMode := k.NewProc("GetConsoleMode"), k.NewProc("SetConsoleMode")
	var mode uint32
	if r, _, _ := getMode.Call(f.Fd(), uintptr(unsafe.Pointer(&mode))); r == 0 {
		return false
	}
	if mode&enableVirtualTerminalProcessing != 0 {
		return true
	}
	r, _, _ := setMode.Call(f.Fd(), uintptr(mode|enableVirtualTerminalProcessing))
	return r != 0
}
