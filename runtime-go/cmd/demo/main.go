package main

import (
	"context"
	"fmt"
	"os"

	runtimego "github.com/egeuysall/sdk/runtime-go"
)

func main() {
	ctx := context.Background()
	tasks := []runtimego.Task{
		task("profile", runtimego.SideEffectRead, nil),
		task("tickets", runtimego.SideEffectRead, nil),
		task("summary", runtimego.SideEffectNone, []string{"profile", "tickets"}),
	}
	results, err := (runtimego.Scheduler{MaxConcurrency: 2}).Run(ctx, tasks)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, result := range results {
		fmt.Printf("%s: %v\n", result.ID, result.Output)
	}
}

func task(id string, sideEffect runtimego.SideEffect, dependsOn []string) runtimego.Task {
	return runtimego.Task{
		ID:         id,
		ToolID:     id,
		SideEffect: sideEffect,
		DependsOn:  dependsOn,
		Run: func(ctx context.Context, task runtimego.Task) (any, error) {
			return "ok", ctx.Err()
		},
	}
}
