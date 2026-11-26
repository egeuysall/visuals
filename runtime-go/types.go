package runtimego

import "context"

type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

type Message struct {
	Role       Role
	Content    string
	ToolCalls  []ToolCall
	ToolCallID string
	Name       string
}

type Tool struct {
	ID          string
	Name        string
	Description string
	InputSchema map[string]any
}

type ToolCall struct {
	ID        string
	ToolID    string
	Arguments map[string]any
}

type Usage struct {
	InputTokens  int
	OutputTokens int
	CachedTokens int
}

type Request struct {
	Model       string
	Messages    []Message
	Tools       []Tool
	Temperature *float64
	MaxTokens   int
}

type Response struct {
	Text         string
	ToolCalls    []ToolCall
	Usage        Usage
	FinishReason string
}

type Provider interface {
	Generate(ctx context.Context, req Request) (Response, error)
}

type ProviderError struct {
	Provider string
	Status   int
	Code     string
	Message  string
}

func (e *ProviderError) Error() string {
	if e.Code == "" {
		return e.Provider + ": " + e.Message
	}
	return e.Provider + ": " + e.Code + ": " + e.Message
}
