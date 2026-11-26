package runtimego

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

type SideEffect string

const (
	SideEffectNone  SideEffect = "none"
	SideEffectRead  SideEffect = "read"
	SideEffectWrite SideEffect = "write"
)

type Task struct {
	ID         string
	ToolID     string
	Input      any
	DependsOn  []string
	SideEffect SideEffect
	Run        func(context.Context, Task) (any, error)
}

type TaskResult struct {
	ID     string
	Output any
	Error  error
}

type Scheduler struct {
	MaxConcurrency int
}

func (s Scheduler) Run(ctx context.Context, tasks []Task) ([]TaskResult, error) {
	maxConcurrency := s.MaxConcurrency
	if maxConcurrency <= 0 {
		maxConcurrency = 4
	}
	remaining := map[string]Task{}
	done := map[string]bool{}
	for _, task := range tasks {
		if task.ID == "" {
			return nil, errors.New("scheduler: task id is required")
		}
		if task.Run == nil {
			return nil, fmt.Errorf("scheduler: task %s has no runner", task.ID)
		}
		if _, exists := remaining[task.ID]; exists {
			return nil, fmt.Errorf("scheduler: duplicate task id %s", task.ID)
		}
		remaining[task.ID] = task
	}
	for _, task := range tasks {
		for _, dep := range task.DependsOn {
			if _, exists := remaining[dep]; !exists {
				return nil, fmt.Errorf("scheduler: task %s depends on unknown task %s", task.ID, dep)
			}
		}
	}

	results := make([]TaskResult, 0, len(tasks))
	for len(remaining) > 0 {
		if err := ctx.Err(); err != nil {
			return results, err
		}
		ready := readyTasks(remaining, done)
		if len(ready) == 0 {
			return results, errors.New("scheduler: dependency cycle")
		}

		var reads, writes []Task
		for _, task := range ready {
			if task.SideEffect == SideEffectWrite {
				writes = append(writes, task)
			} else {
				reads = append(reads, task)
			}
		}
		batch, err := runConcurrent(ctx, reads, maxConcurrency)
		results = append(results, batch...)
		if err != nil {
			return results, err
		}
		for _, task := range reads {
			done[task.ID] = true
			delete(remaining, task.ID)
		}
		for _, task := range writes {
			out, err := task.Run(ctx, task)
			result := TaskResult{ID: task.ID, Output: out, Error: err}
			results = append(results, result)
			if err != nil {
				return results, err
			}
			done[task.ID] = true
			delete(remaining, task.ID)
		}
	}
	return results, nil
}

func readyTasks(remaining map[string]Task, done map[string]bool) []Task {
	var ready []Task
	for _, task := range remaining {
		ok := true
		for _, dep := range task.DependsOn {
			if !done[dep] {
				ok = false
				break
			}
		}
		if ok {
			ready = append(ready, task)
		}
	}
	return ready
}

func runConcurrent(ctx context.Context, tasks []Task, limit int) ([]TaskResult, error) {
	if len(tasks) == 0 {
		return nil, nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	sem := make(chan struct{}, limit)
	results := make([]TaskResult, len(tasks))
	var wg sync.WaitGroup
	var once sync.Once
	var firstErr error

	for i, task := range tasks {
		if err := runCtx.Err(); err != nil {
			wg.Wait()
			if firstErr != nil {
				return results, firstErr
			}
			return results[:i], err
		}
		select {
		case sem <- struct{}{}:
		case <-runCtx.Done():
			wg.Wait()
			if firstErr != nil {
				return results, firstErr
			}
			return results[:i], runCtx.Err()
		}
		wg.Add(1)
		go func(i int, task Task) {
			defer wg.Done()
			defer func() { <-sem }()
			out, err := task.Run(runCtx, task)
			results[i] = TaskResult{ID: task.ID, Output: out, Error: err}
			if err != nil {
				once.Do(func() {
					firstErr = err
					cancel()
				})
			}
		}(i, task)
	}
	wg.Wait()
	return results, firstErr
}
