//go:build windows

package connector

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	aclSizeInformationClass    = 2
	accessAllowedAceType       = 0
	accessAllowedObjectAceType = 5
	fileAddFile                = 0x00000002
	fileAddSubdirectory        = 0x00000004
	fileDeleteChild            = 0x00000040
	deleteAccess               = 0x00010000
	writeDACAccess             = 0x00040000
	writeOwnerAccess           = 0x00080000
	genericWriteAccess         = 0x40000000
	genericAllAccess           = 0x10000000
)

type aclSizeInformation struct {
	AceCount      uint32
	AclBytesInUse uint32
	AclBytesFree  uint32
}

func validateJournalDirectory(path string) error {
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
	userSID := uintptr(unsafe.Pointer(tokenUser.User.Sid))

	var owner, group, dacl, sacl, descriptor uintptr
	result, _, callErr := getNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(name)),
		seFileObject,
		daclSecurityInformation,
		uintptr(unsafe.Pointer(&owner)),
		uintptr(unsafe.Pointer(&group)),
		uintptr(unsafe.Pointer(&dacl)),
		uintptr(unsafe.Pointer(&sacl)),
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return fmt.Errorf("read journal directory ACL: %w", securityCallError(result, callErr))
	}
	if descriptor != 0 {
		defer syscall.LocalFree(syscall.Handle(descriptor))
	}
	if dacl == 0 {
		return fmt.Errorf("journal directory %q has no DACL", path)
	}

	var size aclSizeInformation
	result, _, callErr = getAclInformation.Call(
		dacl,
		uintptr(unsafe.Pointer(&size)),
		unsafe.Sizeof(size),
		aclSizeInformationClass,
	)
	if result == 0 {
		return fmt.Errorf("read journal directory ACL entries: %w", callErr)
	}
	for index := uint32(0); index < size.AceCount; index++ {
		var ace uintptr
		result, _, callErr = getAce.Call(dacl, uintptr(index), uintptr(unsafe.Pointer(&ace)))
		if result == 0 || ace == 0 {
			return fmt.Errorf("read journal directory ACL entry %d: %w", index, callErr)
		}
		aceType := *(*byte)(unsafe.Pointer(ace))
		mask, aceSID, ok := allowedACEAccess(aceType, ace)
		if !ok || mask&dangerousDirectoryAccess == 0 {
			continue
		}
		equal, _, _ := equalSid.Call(userSID, aceSID)
		if equal == 0 && !trustedWindowsPrincipal(aceSID) {
			return fmt.Errorf("journal directory %q grants non-owner modification rights", path)
		}
	}
	return nil
}

func trustedWindowsPrincipal(sid uintptr) bool {
	var text uintptr
	result, _, _ := convertSidToStringSid.Call(sid, uintptr(unsafe.Pointer(&text)))
	if result == 0 || text == 0 {
		return false
	}
	defer syscall.LocalFree(syscall.Handle(text))
	value := syscall.UTF16ToString((*[1 << 20]uint16)(unsafe.Pointer(text))[:])
	switch value {
	case "S-1-5-18", "S-1-5-32-544":
		return true
	default:
		return false
	}
}

const dangerousDirectoryAccess = fileAddFile | fileAddSubdirectory | fileDeleteChild | deleteAccess | writeDACAccess | writeOwnerAccess | genericWriteAccess | genericAllAccess

func allowedACEAccess(aceType byte, ace uintptr) (uint32, uintptr, bool) {
	switch aceType {
	case accessAllowedAceType:
		return *(*uint32)(unsafe.Pointer(ace + 4)), ace + 8, true
	case accessAllowedObjectAceType:
		flags := *(*uint32)(unsafe.Pointer(ace + 8))
		offset := uintptr(12)
		if flags&0x1 != 0 {
			offset += 16
		}
		if flags&0x2 != 0 {
			offset += 16
		}
		return *(*uint32)(unsafe.Pointer(ace + 4)), ace + offset, true
	default:
		return 0, 0, false
	}
}

func securityCallError(result uintptr, callErr error) error {
	if result != 0 {
		return syscall.Errno(result)
	}
	return callErr
}
