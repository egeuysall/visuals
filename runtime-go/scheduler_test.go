package runtimego

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestSchedulerRunsReadsConcurrentlyAndHonorsDependencies(t *testing.T) {
	var mu sync.Mutex
	started := map[string]bool{}
	task := func(id string, deps []string) Task {
		return Task{
			ID:         id,
			DependsOn:  deps,
			SideEffect: SideEffectRead,
			Run: func(ctx context.Context, task Task) (any, error) {
				mu.Lock()
				for _, dep := range task.DependsOn {
					if !started[dep] {
						t.Errorf("%s started before dependency %s", task.ID, dep)
					}
				}
				started[task.ID] = true
				mu.Unlock()
				time.Sleep(20 * time.Millisecond)
				return task.ID, nil
			},
		}
	}
	start := time.Now()
	results, err := (Scheduler{MaxConcurrency: 2}).Run(context.Background(), []Task{
		task("a", nil),
		task("b", nil),
		task("c", []string{"a", "b"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("results = %d", len(results))
	}
	if elapsed := time.Since(start); elapsed > 55*time.Millisecond {
		t.Fatalf("reads did not run concurrently: %s", elapsed)
	}
}

func TestSchedulerSerializesWrites(t *testing.T) {
	var mu sync.Mutex
	activeWrites := 0
	maxActiveWrites := 0
	write := func(id string) Task {
		return Task{
			ID:         id,
			SideEffect: SideEffectWrite,
			Run: func(ctx context.Context, task Task) (any, error) {
				mu.Lock()
				activeWrites++
				if activeWrites > maxActiveWrites {
					maxActiveWrites = activeWrites
				}
				mu.Unlock()
				time.Sleep(10 * time.Millisecond)
				mu.Lock()
				activeWrites--
				mu.Unlock()
				return task.ID, nil
			},
		}
	}
	_, err := (Scheduler{MaxConcurrency: 8}).Run(context.Background(), []Task{write("a"), write("b"), write("c")})
	if err != nil {
		t.Fatal(err)
	}
	if maxActiveWrites != 1 {
		t.Fatalf("writes overlapped: %d", maxActiveWrites)
	}
}

func TestSchedulerRejectsCycles(t *testing.T) {
	_, err := (Scheduler{}).Run(context.Background(), []Task{{
		ID:        "a",
		DependsOn: []string{"b"},
		Run:       func(context.Context, Task) (any, error) { return nil, nil },
	}, {
		ID:        "b",
		DependsOn: []string{"a"},
		Run:       func(context.Context, Task) (any, error) { return nil, nil },
	}})
	if err == nil {
		t.Fatal("expected cycle error")
	}
}

func TestSchedulerCancelsReadSiblingsAfterFailure(t *testing.T) {
	started := make(chan struct{})
	failed := errors.New("boom")
	_, err := (Scheduler{MaxConcurrency: 2}).Run(context.Background(), []Task{
		{
			ID:         "fail",
			SideEffect: SideEffectRead,
			Run: func(context.Context, Task) (any, error) {
				close(started)
				return nil, failed
			},
		},
		{
			ID:         "sibling",
			SideEffect: SideEffectRead,
			Run: func(ctx context.Context, _ Task) (any, error) {
				<-started
				<-ctx.Done()
				return nil, ctx.Err()
			},
		},
	})
	if !errors.Is(err, failed) {
		t.Fatalf("expected first failure, got %v", err)
	}
}
