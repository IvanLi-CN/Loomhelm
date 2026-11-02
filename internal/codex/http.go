package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
)

func (s *Service) handleListSources(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 来源不可用")
		return
	}
	response, err := s.ListSources(request.Context(), principal)
	if err != nil {
		s.writeError(writer, request, err, "读取 Codex 来源失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (s *Service) handleListProjects(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 项目不可用")
		return
	}
	query, err := parseProjectQuery(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 项目查询无效")
		return
	}
	response, err := s.ListProjects(request.Context(), principal, query)
	if err != nil {
		s.writeError(writer, request, err, "读取 Codex 项目失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (s *Service) handleListConversations(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 对话不可用")
		return
	}
	query, err := parseConversationQuery(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 对话查询无效")
		return
	}
	response, err := s.ListConversations(request.Context(), principal, query)
	if err != nil {
		s.writeError(writer, request, err, "读取 Codex 对话失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (s *Service) handleGetConversation(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 对话不可用")
		return
	}
	response, err := s.GetConversation(request.Context(), principal, chi.URLParam(request, "host_id"), chi.URLParam(request, "thread_id"))
	if err != nil {
		s.writeError(writer, request, err, "读取 Codex 对话失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (s *Service) handleUpdateTitle(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 标题不可用")
		return
	}
	var body protocol.CodexTitleUpdateRequest
	if err := decodeBody(request, &body); err != nil {
		s.writeError(writer, request, err, "标题请求无效")
		return
	}
	conversation, err := s.UpdateTitle(request.Context(), principal, chi.URLParam(request, "host_id"), chi.URLParam(request, "thread_id"), body)
	if err != nil {
		s.writeError(writer, request, err, "更新 Loomhelm 对话标题失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, protocol.CodexConversationResponse{Conversation: conversation})
}

func (s *Service) handleMapProject(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 项目映射不可用")
		return
	}
	var body protocol.CodexMappingRequest
	if err := decodeBody(request, &body); err != nil {
		s.writeError(writer, request, err, "Codex 项目映射请求无效")
		return
	}
	project, err := s.MapProject(request.Context(), principal, chi.URLParam(request, "host_id"), chi.URLParam(request, "project_id"), body)
	if err != nil {
		s.writeError(writer, request, err, "建立 Codex 项目映射失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, protocol.CodexProjectResponse{Project: project})
}

func (s *Service) handleBind(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 绑定不可用")
		return
	}
	var body protocol.CodexBindRequest
	if err := decodeBody(request, &body); err != nil {
		s.writeError(writer, request, err, "Codex 绑定请求无效")
		return
	}
	conversation, err := s.Bind(request.Context(), principal, chi.URLParam(request, "host_id"), chi.URLParam(request, "thread_id"), body)
	if err != nil {
		s.writeError(writer, request, err, "绑定 Codex 对话失败")
		return
	}
	auth.WriteJSON(writer, http.StatusOK, protocol.CodexConversationResponse{Conversation: conversation})
}

func (s *Service) handleSync(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principalForRequest(request)
	if err != nil {
		s.writeError(writer, request, err, "Codex 同步不可用")
		return
	}
	var body protocol.CodexSyncRequest
	if request.ContentLength != 0 {
		if err := decodeBody(request, &body); err != nil {
			s.writeError(writer, request, err, "Codex 同步请求无效")
			return
		}
	}
	response, err := s.RequestSync(request.Context(), principal, body)
	if err != nil {
		s.writeError(writer, request, err, "请求 Codex 同步失败")
		return
	}
	auth.WriteJSON(writer, http.StatusAccepted, response)
}

func decodeBody(request *http.Request, target any) error {
	if request.Body == nil {
		return ErrInvalid
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return nil
}

func parseProjectQuery(request *http.Request) (protocol.ListCodexProjectsQuery, error) {
	values := request.URL.Query()
	query := protocol.ListCodexProjectsQuery{HostID: optionalQuery(values.Get("host_id")), AfterCursor: optionalQuery(values.Get("after_cursor"))}
	limit, err := parseLimit(values.Get("limit"))
	if err != nil {
		return query, err
	}
	query.Limit = limit
	return query, nil
}

func parseConversationQuery(request *http.Request) (protocol.ListCodexConversationsQuery, error) {
	values := request.URL.Query()
	query := protocol.ListCodexConversationsQuery{
		HostID:            optionalQuery(values.Get("host_id")),
		ProjectID:         optionalQuery(values.Get("project_id")),
		LoomhelmProjectID: optionalQuery(values.Get("loomhelm_project_id")),
		Search:            optionalQuery(values.Get("search")),
		AfterCursor:       optionalQuery(values.Get("after_cursor")),
	}
	limit, err := parseLimit(values.Get("limit"))
	if err != nil {
		return query, err
	}
	query.Limit = limit
	for _, key := range []string{"bound", "include_archived"} {
		value := values.Get(key)
		if value == "" {
			continue
		}
		parsed, parseErr := strconv.ParseBool(value)
		if parseErr != nil {
			return query, fmt.Errorf("%w: %s must be boolean", ErrInvalid, key)
		}
		if key == "bound" {
			query.Bound = &parsed
		} else {
			query.IncludeArchived = &parsed
		}
	}
	return query, nil
}

func parseLimit(value string) (*int64, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 {
		return nil, fmt.Errorf("%w: limit must be a positive integer", ErrInvalid)
	}
	return &parsed, nil
}

func optionalQuery(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func (s *Service) writeError(writer http.ResponseWriter, request *http.Request, err error, message string) {
	if err == nil {
		err = auth.ErrUnavailable
	}
	status := auth.StatusForError(err)
	switch {
	case errors.Is(err, ErrInvalid):
		status, err = http.StatusBadRequest, auth.ErrInvalid
	case errors.Is(err, ErrNotFound):
		status, err = http.StatusNotFound, auth.ErrNotFound
	case errors.Is(err, ErrForbidden):
		status, err = http.StatusForbidden, auth.ErrForbidden
	case errors.Is(err, ErrConflict), errors.Is(err, ErrIncompleteHistory), errors.Is(err, ErrCapabilityUnsupported):
		status, err = http.StatusConflict, auth.ErrConflict
	case errors.Is(err, ErrSourceUnavailable):
		status, err = http.StatusServiceUnavailable, auth.ErrUnavailable
	case errors.Is(err, hosts.ErrNotFound):
		status, err = http.StatusNotFound, auth.ErrNotFound
	case errors.Is(err, hosts.ErrForbidden):
		status, err = http.StatusNotFound, auth.ErrNotFound
	case !isApplicationAuthError(err):
		status, err = http.StatusServiceUnavailable, auth.ErrUnavailable
	}
	auth.WriteError(writer, request, status, err, message)
}

func isApplicationAuthError(err error) bool {
	return errors.Is(err, auth.ErrUnauthenticated) || errors.Is(err, auth.ErrForbidden) || errors.Is(err, auth.ErrInvalid) || errors.Is(err, auth.ErrNotFound) || errors.Is(err, auth.ErrConflict) || errors.Is(err, auth.ErrUnavailable)
}
