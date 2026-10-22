//go:build windows

package connector

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func allowedJournalAncestorSymlink(string) bool { return false }

const (
	securityDescriptorRevision       = 1
	seFileObject                     = 1
	daclSecurityInformation          = 0x00000004
	protectedDaclSecurityInformation = 0x80000000
)

var (
	convertStringSecurityDescriptor = syscall.NewLazyDLL("advapi32.dll").NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	getSecurityDescriptorDacl       = syscall.NewLazyDLL("advapi32.dll").NewProc("GetSecurityDescriptorDacl")
	getSecurityInfo                 = syscall.NewLazyDLL("advapi32.dll").NewProc("GetSecurityInfo")
	getNamedSecurityInfo            = syscall.NewLazyDLL("advapi32.dll").NewProc("GetNamedSecurityInfoW")
	getAclInformation               = syscall.NewLazyDLL("advapi32.dll").NewProc("GetAclInformation")
	getAce                          = syscall.NewLazyDLL("advapi32.dll").NewProc("GetAce")
	equalSid                        = syscall.NewLazyDLL("advapi32.dll").NewProc("EqualSid")
	convertSidToStringSid           = syscall.NewLazyDLL("advapi32.dll").NewProc("ConvertSidToStringSidW")
	setSecurityInfo                 = syscall.NewLazyDLL("advapi32.dll").NewProc("SetSecurityInfo")
)

func validateJournalFileHandle(file *os.File) error {
	if file == nil {
		return fmt.Errorf("journal file handle must not be nil")
	}
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat opened journal file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("opened journal path %q is not a regular file", file.Name())
	}
	return validateJournalHandle(syscall.Handle(file.Fd()), file.Name(), false)
}

func validateJournalDirectoryRoot(root *os.Root, path string, info os.FileInfo) error {
	if !info.IsDir() {
		return fmt.Errorf("journal parent path %q is not a directory", path)
	}
	directory, err := root.OpenFile(".", os.O_RDONLY|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fmt.Errorf("open journal directory handle %q: %w", path, err)
	}
	defer directory.Close()
	return validateJournalHandle(syscall.Handle(directory.Fd()), path, true)
}

func secureJournalDirectoryRoot(root *os.Root, path string) error {
	if root == nil {
		return fmt.Errorf("journal directory root must not be nil")
	}
	directory, err := root.OpenFile(".", os.O_RDONLY|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fmt.Errorf("open journal directory handle %q: %w", path, err)
	}
	defer directory.Close()
	if err := secureJournalHandle(syscall.Handle(directory.Fd())); err != nil {
		return fmt.Errorf("secure opened journal directory %q: %w", path, err)
	}
	return nil
}

func validateJournalHandle(handle syscall.Handle, path string, directory bool) error {
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
	securityInformation := uint32(ownerSecurityInformation)
	if directory {
		securityInformation |= daclSecurityInformation
	}
	var owner, group, dacl, sacl, descriptor uintptr
	result, _, callErr := getSecurityInfo.Call(
		uintptr(handle),
		seFileObject,
		uintptr(securityInformation),
		uintptr(unsafe.Pointer(&owner)),
		uintptr(unsafe.Pointer(&group)),
		uintptr(unsafe.Pointer(&dacl)),
		uintptr(unsafe.Pointer(&sacl)),
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return fmt.Errorf("read opened journal security descriptor: %w", securityCallError(result, callErr))
	}
	if descriptor != 0 {
		defer syscall.LocalFree(syscall.Handle(descriptor))
	}
	if owner == 0 {
		return fmt.Errorf("journal path %q has no owner", path)
	}
	equal, _, _ := equalSid.Call(userSID, owner)
	if equal == 0 {
		return fmt.Errorf("journal path %q is not owned by the current user", path)
	}
	if !directory {
		return nil
	}
	if dacl == 0 {
		return fmt.Errorf("journal directory %q has no DACL", path)
	}
	return validateJournalDACL(path, dacl, userSID)
}

func validateJournalDACL(path string, dacl, userSID uintptr) error {
	var size aclSizeInformation
	result, _, callErr := getAclInformation.Call(
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
		if !ok {
			if isAllowedACEType(aceType) {
				return fmt.Errorf("journal directory %q contains unsupported allow ACE type %d", path, aceType)
			}
			continue
		}
		if mask&(dangerousDirectoryAccess|readableDirectoryAccess) == 0 {
			continue
		}
		equal, _, _ := equalSid.Call(userSID, aceSID)
		if equal == 0 && !trustedWindowsPrincipal(aceSID) {
			if mask&readableDirectoryAccess != 0 {
				return fmt.Errorf("journal directory %q grants non-owner read rights", path)
			}
			return fmt.Errorf("journal directory %q grants non-owner modification rights", path)
		}
	}
	return nil
}

func secureJournalFile(file *os.File) error {
	if file == nil {
		return fmt.Errorf("journal file handle must not be nil")
	}
	if err := secureJournalHandle(syscall.Handle(file.Fd())); err != nil {
		return fmt.Errorf("secure opened journal file %q: %w", file.Name(), err)
	}
	return nil
}

func secureJournalHandle(handle syscall.Handle) error {
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
	var present, defaulted, dacl uintptr
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
	result, _, callErr = setSecurityInfo.Call(
		uintptr(handle),
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
