package approvals

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestEnsureHistoryReadyFailsClosedWhenInspectionFails(t *testing.T) {
	querier := &readinessQuerierStub{rows: []pgx.Row{
		readinessRow{err: errors.New("database unavailable")},
	}}

	err := ensureHistoryReady(context.Background(), querier)
	if !errors.Is(err, ErrApprovalHistoryUnavailable) {
		t.Fatalf("readiness error = %v, want ErrApprovalHistoryUnavailable", err)
	}
	if querier.calls != 1 {
		t.Fatalf("readiness queries = %d, want 1 after inspection failure", querier.calls)
	}
}

func TestEnsureHistoryReadyFailsClosedWhenCutoverIsIncomplete(t *testing.T) {
	cases := []struct {
		name string
		row  []any
	}{
		{name: "projection missing", row: []any{false, true, true, true, true}},
		{name: "history missing", row: []any{true, false, true, true, true}},
		{name: "required schema missing", row: []any{true, true, false, true, true}},
		{name: "history indexes missing", row: []any{true, true, true, false, true}},
		{name: "writer trigger missing", row: []any{true, true, true, true, false}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			querier := &readinessQuerierStub{rows: []pgx.Row{
				readinessRow{values: testCase.row},
			}}

			err := ensureHistoryReady(context.Background(), querier)
			if !errors.Is(err, ErrApprovalHistoryUnavailable) {
				t.Fatalf("readiness error = %v, want ErrApprovalHistoryUnavailable", err)
			}
			if querier.calls != 1 {
				t.Fatalf("readiness queries = %d, want 1 for incomplete cutover", querier.calls)
			}
		})
	}
}

func TestEnsureHistoryReadyFailsClosedOnProjectionHistoryDrift(t *testing.T) {
	querier := &readinessQuerierStub{rows: []pgx.Row{
		readinessRow{values: []any{true, true, true, true, true}},
		readinessRow{values: []any{true}},
	}}

	err := ensureHistoryReady(context.Background(), querier)
	if !errors.Is(err, ErrApprovalHistoryUnavailable) {
		t.Fatalf("readiness error = %v, want ErrApprovalHistoryUnavailable", err)
	}
	if querier.calls != 2 {
		t.Fatalf("readiness queries = %d, want 2 after drift", querier.calls)
	}
}

func TestEnsureHistoryReadyAcceptsCompleteCutover(t *testing.T) {
	querier := &readinessQuerierStub{rows: []pgx.Row{
		readinessRow{values: []any{true, true, true, true, true}},
		readinessRow{values: []any{false}},
	}}

	if err := ensureHistoryReady(context.Background(), querier); err != nil {
		t.Fatalf("complete cutover readiness error = %v", err)
	}
	if querier.calls != 2 {
		t.Fatalf("readiness queries = %d, want 2 for complete cutover", querier.calls)
	}
}

type readinessQuerierStub struct {
	rows  []pgx.Row
	calls int
}

func (s *readinessQuerierStub) QueryRow(context.Context, string, ...any) pgx.Row {
	if s.calls >= len(s.rows) {
		return readinessRow{err: fmt.Errorf("unexpected readiness query %d", s.calls+1)}
	}
	row := s.rows[s.calls]
	s.calls++
	return row
}

type readinessRow struct {
	values []any
	err    error
}

func (r readinessRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return fmt.Errorf("scan destinations = %d, values = %d", len(dest), len(r.values))
	}
	for index, value := range r.values {
		target, ok := dest[index].(*bool)
		if !ok {
			return fmt.Errorf("destination %d is %T, want *bool", index, dest[index])
		}
		boolean, ok := value.(bool)
		if !ok {
			return fmt.Errorf("value %d is %T, want bool", index, value)
		}
		*target = boolean
	}
	return nil
}
