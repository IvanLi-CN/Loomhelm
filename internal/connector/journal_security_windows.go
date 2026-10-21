//go:build windows

package connector

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	securityDescriptorRevision       = 1
	seFileObject                     = 1
	daclSecurityInformation          = 0x00000004
	protectedDaclSecurityInformation = 0x80000000
)

var (
	convertStringSecurityDescriptor = syscall.NewLazyDLL("advapi32.dll").NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	getSecurityDescriptorDacl       = syscall.NewLazyDLL("advapi32.dll").NewProc("GetSecurityDescriptorDacl")
	getNamedSecurityInfo            = syscall.NewLazyDLL("advapi32.dll").NewProc("GetNamedSecurityInfoW")
	getAclInformation               = syscall.NewLazyDLL("advapi32.dll").NewProc("GetAclInformation")
	getAce                          = syscall.NewLazyDLL("advapi32.dll").NewProc("GetAce")
	equalSid                        = syscall.NewLazyDLL("advapi32.dll").NewProc("EqualSid")
	convertSidToStringSid           = syscall.NewLazyDLL("advapi32.dll").NewProc("ConvertSidToStringSidW")
	setNamedSecurityInfo            = syscall.NewLazyDLL("advapi32.dll").NewProc("SetNamedSecurityInfoW")
)

// secureJournalPath applies a protected owner-only DACL. Go's Windows chmod
// compatibility behavior does not make journal contents private by itself.
func secureJournalPath(path string) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return fmt.Errorf("open current process token: %w", err)
	}
	defer token.Close()
	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return fmt.Errorf("read current process user: %w", err)
	}
	userSID, err := tokenUser.User.Sid.String()
	if err != nil {
		return fmt.Errorf("format current process user: %w", err)
	}
	sddl, err := syscall.UTF16PtrFromString(fmt.Sprintf("D:P(A;;FA;;;%s)", userSID))
	if err != nil {
		return err
	}
	var descriptor uintptr
	var descriptorSize uint32
	result, _, callErr := convertStringSecurityDescriptor.Call(
		uintptr(unsafe.Pointer(sddl)),
		securityDescriptorRevision,
		uintptr(unsafe.Pointer(&descriptor)),
		uintptr(unsafe.Pointer(&descriptorSize)),
	)
	if result == 0 {
		return fmt.Errorf("convert journal ACL: %w", callErr)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))

	var present uint32
	var defaulted uint32
	var dacl uintptr
	result, _, callErr = getSecurityDescriptorDacl.Call(
		descriptor,
		uintptr(unsafe.Pointer(&present)),
		uintptr(unsafe.Pointer(&dacl)),
		uintptr(unsafe.Pointer(&defaulted)),
	)
	if result == 0 {
		return fmt.Errorf("read journal ACL: %w", callErr)
	}
	if present == 0 || dacl == 0 {
		return fmt.Errorf("journal ACL did not contain a DACL")
	}
	result, _, callErr = setNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(name)),
		seFileObject,
		daclSecurityInformation|protectedDaclSecurityInformation,
		0,
		0,
		dacl,
		0,
	)
	if result != 0 {
		return fmt.Errorf("set journal ACL: %w", syscall.Errno(result))
	}
	return nil
}
