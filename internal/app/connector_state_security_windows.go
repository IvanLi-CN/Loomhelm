//go:build windows

package app

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	connectorSecurityDescriptorRevision       = 1
	connectorSeFileObject                     = 1
	connectorOwnerSecurityInformation         = 0x00000001
	connectorDaclSecurityInformation          = 0x00000004
	connectorProtectedDaclSecurityInformation = 0x80000000
	connectorACLSizeInformationClass          = 2

	connectorAccessAllowedACEType         = 0
	connectorAccessAllowedObjectACEType   = 5
	connectorAccessAllowedCompoundACEType = 4
	connectorAccessAllowedCallbackACEType = 9
	connectorAccessAllowedCallbackObject  = 11

	connectorFileReadData        = 0x00000001
	connectorFileWriteData       = 0x00000002
	connectorFileAppendData      = 0x00000004
	connectorFileExecute         = 0x00000020
	connectorFileListDirectory   = 0x00000001
	connectorFileAddFile         = 0x00000002
	connectorFileAddSubdirectory = 0x00000004
	connectorFileDeleteChild     = 0x00000040
	connectorDeleteAccess        = 0x00010000
	connectorReadControlAccess   = 0x00020000
	connectorWriteDACAccess      = 0x00040000
	connectorWriteOwnerAccess    = 0x00080000
	connectorGenericReadAccess   = 0x80000000
	connectorGenericWriteAccess  = 0x40000000
	connectorGenericAllAccess    = 0x10000000
)

type connectorACLSizeInformation struct {
	AceCount      uint32
	AclBytesInUse uint32
	AclBytesFree  uint32
}

var (
	connectorConvertStringSecurityDescriptor = syscall.NewLazyDLL("advapi32.dll").NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	connectorGetSecurityDescriptorDACL       = syscall.NewLazyDLL("advapi32.dll").NewProc("GetSecurityDescriptorDacl")
	connectorGetNamedSecurityInfo            = syscall.NewLazyDLL("advapi32.dll").NewProc("GetNamedSecurityInfoW")
	connectorGetSecurityInfo                 = syscall.NewLazyDLL("advapi32.dll").NewProc("GetSecurityInfo")
	connectorGetACLInformation               = syscall.NewLazyDLL("advapi32.dll").NewProc("GetAclInformation")
	connectorGetACE                          = syscall.NewLazyDLL("advapi32.dll").NewProc("GetAce")
	connectorEqualSID                        = syscall.NewLazyDLL("advapi32.dll").NewProc("EqualSid")
	connectorConvertSIDToStringSID           = syscall.NewLazyDLL("advapi32.dll").NewProc("ConvertSidToStringSidW")
	connectorSetSecurityInfo                 = syscall.NewLazyDLL("advapi32.dll").NewProc("SetSecurityInfo")
)

func connectorStatePermissionsTooBroad(os.FileInfo) bool {
	// Windows FileMode.Perm does not represent the file ACL. ACL checks below
	// enforce the equivalent owner-only state-file policy.
	return false
}

func secureConnectorStateDirectory(path string) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(
		name,
		syscall.GENERIC_READ|connectorWriteDACAccess,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	return secureConnectorStateHandle(handle)
}

func validateConnectorStateDirectorySecurity(path string) error {
	return validateConnectorStatePath(path, true)
}

func secureConnectorStateFile(file *os.File) error {
	if file == nil {
		return fmt.Errorf("Connector state file handle must not be nil")
	}
	return secureConnectorStateHandle(syscall.Handle(file.Fd()))
}

func validateConnectorStateFile(path string) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("format Connector state path: %w", err)
	}
	return validateConnectorStateNamedPath(name, path, false)
}

func validateConnectorStateFileHandle(file *os.File) error {
	if file == nil {
		return fmt.Errorf("Connector state file handle must not be nil")
	}
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat Connector state file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Connector state path %q is not a regular file", file.Name())
	}
	return validateConnectorStateHandle(syscall.Handle(file.Fd()), file.Name(), false)
}

func validateConnectorStatePath(path string, directory bool) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("format Connector state path: %w", err)
	}
	return validateConnectorStateNamedPath(name, path, directory)
}

func validateConnectorStateNamedPath(name *uint16, path string, directory bool) error {
	var owner, group, dacl, sacl, descriptor uintptr
	result, _, callErr := connectorGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(name)),
		connectorSeFileObject,
		connectorOwnerSecurityInformation|connectorDaclSecurityInformation,
		uintptr(unsafe.Pointer(&owner)),
		uintptr(unsafe.Pointer(&group)),
		uintptr(unsafe.Pointer(&dacl)),
		uintptr(unsafe.Pointer(&sacl)),
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return fmt.Errorf("read Connector state ACL: %w", connectorSecurityCallError(result, callErr))
	}
	if descriptor != 0 {
		defer syscall.LocalFree(syscall.Handle(descriptor))
	}
	return validateConnectorStateSecurity(path, owner, dacl, directory)
}

func validateConnectorStateHandle(handle syscall.Handle, path string, directory bool) error {
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
	result, _, callErr := connectorGetSecurityInfo.Call(
		uintptr(handle),
		connectorSeFileObject,
		connectorOwnerSecurityInformation|connectorDaclSecurityInformation,
		uintptr(unsafe.Pointer(&owner)),
		uintptr(unsafe.Pointer(&group)),
		uintptr(unsafe.Pointer(&dacl)),
		uintptr(unsafe.Pointer(&sacl)),
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return fmt.Errorf("read opened Connector state ACL: %w", connectorSecurityCallError(result, callErr))
	}
	if descriptor != 0 {
		defer syscall.LocalFree(syscall.Handle(descriptor))
	}
	return validateConnectorStateSecurityWithUser(path, owner, dacl, directory, userSID)
}

func validateConnectorStateSecurity(path string, owner, dacl uintptr, directory bool) error {
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
	return validateConnectorStateSecurityWithUser(path, owner, dacl, directory, userSID)
}

func validateConnectorStateSecurityWithUser(path string, owner, dacl uintptr, directory bool, userSID uintptr) error {
	if owner == 0 {
		return fmt.Errorf("Connector state path %q has no owner", path)
	}
	equal, _, _ := connectorEqualSID.Call(userSID, owner)
	if equal == 0 {
		return fmt.Errorf("Connector state path %q is not owned by the current user", path)
	}
	if dacl == 0 {
		return fmt.Errorf("Connector state path %q has no DACL", path)
	}
	return validateConnectorStateDACL(path, dacl, directory, userSID)
}

func validateConnectorStateDACL(path string, dacl uintptr, directory bool, userSID uintptr) error {
	var size connectorACLSizeInformation
	result, _, callErr := connectorGetACLInformation.Call(
		dacl,
		uintptr(unsafe.Pointer(&size)),
		unsafe.Sizeof(size),
		connectorACLSizeInformationClass,
	)
	if result == 0 {
		return fmt.Errorf("read Connector state ACL entries: %w", callErr)
	}
	var dangerous, readable uint32
	if directory {
		dangerous = connectorFileAddFile | connectorFileAddSubdirectory | connectorFileDeleteChild | connectorDeleteAccess | connectorWriteDACAccess | connectorWriteOwnerAccess | connectorGenericWriteAccess | connectorGenericAllAccess
		readable = connectorFileListDirectory | connectorReadControlAccess | connectorGenericReadAccess
	} else {
		dangerous = connectorFileWriteData | connectorFileAppendData | connectorDeleteAccess | connectorWriteDACAccess | connectorWriteOwnerAccess | connectorGenericWriteAccess | connectorGenericAllAccess
		readable = connectorFileReadData | connectorFileExecute | connectorReadControlAccess | connectorGenericReadAccess
	}
	for index := uint32(0); index < size.AceCount; index++ {
		var ace uintptr
		result, _, callErr = connectorGetACE.Call(dacl, uintptr(index), uintptr(unsafe.Pointer(&ace)))
		if result == 0 || ace == 0 {
			return fmt.Errorf("read Connector state ACL entry %d: %w", index, callErr)
		}
		aceType := *(*byte)(unsafe.Pointer(ace))
		mask, aceSID, ok := connectorAllowedACEAccess(aceType, ace)
		if !ok {
			if connectorIsAllowedACEType(aceType) {
				return fmt.Errorf("Connector state path %q contains unsupported allow ACE type %d", path, aceType)
			}
			continue
		}
		if mask&(dangerous|readable) == 0 {
			continue
		}
		equal, _, _ := connectorEqualSID.Call(userSID, aceSID)
		if equal == 0 && !connectorTrustedWindowsPrincipal(aceSID) {
			if mask&readable != 0 {
				return fmt.Errorf("Connector state path %q grants non-owner read rights", path)
			}
			return fmt.Errorf("Connector state path %q grants non-owner modification rights", path)
		}
	}
	return nil
}

func connectorTrustedWindowsPrincipal(sid uintptr) bool {
	var text uintptr
	result, _, _ := connectorConvertSIDToStringSID.Call(sid, uintptr(unsafe.Pointer(&text)))
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

func connectorAllowedACEAccess(aceType byte, ace uintptr) (uint32, uintptr, bool) {
	switch aceType {
	case connectorAccessAllowedACEType:
		return *(*uint32)(unsafe.Pointer(ace + 4)), ace + 8, true
	case connectorAccessAllowedObjectACEType:
		flags := *(*uint32)(unsafe.Pointer(ace + 8))
		if flags&^0x3 != 0 {
			return 0, 0, false
		}
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

func connectorIsAllowedACEType(aceType byte) bool {
	switch aceType {
	case connectorAccessAllowedACEType, connectorAccessAllowedObjectACEType, connectorAccessAllowedCompoundACEType, connectorAccessAllowedCallbackACEType, connectorAccessAllowedCallbackObject:
		return true
	default:
		return false
	}
}

func connectorSecurityCallError(result uintptr, callErr error) error {
	if result != 0 {
		return syscall.Errno(result)
	}
	return callErr
}

func secureConnectorStateHandle(handle syscall.Handle) error {
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
	result, _, callErr := connectorConvertStringSecurityDescriptor.Call(
		uintptr(unsafe.Pointer(sddl)),
		connectorSecurityDescriptorRevision,
		uintptr(unsafe.Pointer(&descriptor)),
		uintptr(unsafe.Pointer(&descriptorSize)),
	)
	if result == 0 {
		return fmt.Errorf("convert Connector state ACL: %w", callErr)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	var present, defaulted, dacl uintptr
	result, _, callErr = connectorGetSecurityDescriptorDACL.Call(
		descriptor,
		uintptr(unsafe.Pointer(&present)),
		uintptr(unsafe.Pointer(&dacl)),
		uintptr(unsafe.Pointer(&defaulted)),
	)
	if result == 0 {
		return fmt.Errorf("read Connector state ACL: %w", callErr)
	}
	if present == 0 || dacl == 0 {
		return fmt.Errorf("Connector state ACL did not contain a DACL")
	}
	result, _, callErr = connectorSetSecurityInfo.Call(
		uintptr(handle),
		connectorSeFileObject,
		connectorDaclSecurityInformation|connectorProtectedDaclSecurityInformation,
		0,
		0,
		dacl,
		0,
	)
	if result != 0 {
		return fmt.Errorf("set Connector state ACL: %w", syscall.Errno(result))
	}
	return nil
}
