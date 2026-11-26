package runtimego

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultOpenAIURL        = "https://api.openai.com/v1/responses"
	defaultAnthropicURL     = "https://api.anthropic.com/v1/messages"
	defaultAnthropicVersion = "2023-06-01"
)

type OpenAIAdapter struct {
	APIKey string
	URL    string
	Client *http.Client
}

type AnthropicAdapter struct {
	APIKey  string
	URL     string
	Version string
	Client  *http.Client
}

func (a OpenAIAdapter) Generate(ctx context.Context, req Request) (Response, error) {
	if strings.TrimSpace(a.APIKey) == "" {
		return Response{}, errors.New("openai: API key is required")
	}
	body := map[string]any{
		"model": req.Model,
		"input": openAIInput(req.Messages, req.Tools),
	}
	if len(req.Tools) > 0 {
		body["tools"] = openAITools(req.Tools)
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.MaxTokens > 0 {
		body["max_output_tokens"] = req.MaxTokens
	}

	var out openAIResponse
	if err := postJSON(ctx, a.client(), endpoint(a.URL, defaultOpenAIURL), body, map[string]string{
		"Authorization": "Bearer " + a.APIKey,
	}, "openai", &out); err != nil {
		return Response{}, err
	}
	return out.normalize(req.Tools)
}

func (a AnthropicAdapter) Generate(ctx context.Context, req Request) (Response, error) {
	if strings.TrimSpace(a.APIKey) == "" {
		return Response{}, errors.New("anthropic: API key is required")
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1024
	}
	body := map[string]any{
		"model":      req.Model,
		"max_tokens": maxTokens,
		"messages":   anthropicMessages(req.Messages, req.Tools),
	}
	if system := systemText(req.Messages); system != "" {
		body["system"] = system
	}
	if len(req.Tools) > 0 {
		body["tools"] = anthropicTools(req.Tools)
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}

	version := a.Version
	if version == "" {
		version = defaultAnthropicVersion
	}
	var out anthropicResponse
	if err := postJSON(ctx, a.client(), endpoint(a.URL, defaultAnthropicURL), body, map[string]string{
		"x-api-key":         a.APIKey,
		"anthropic-version": version,
	}, "anthropic", &out); err != nil {
		return Response{}, err
	}
	return out.normalize(req.Tools)
}

func (a OpenAIAdapter) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (a AnthropicAdapter) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func postJSON(ctx context.Context, client *http.Client, url string, body any, headers map[string]string, provider string, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("accept", "application/json")
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}
	httpResp, err := client.Do(httpReq)
	if err != nil {
		return err
	}
	defer httpResp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(httpResp.Body, 4<<20))
	if err != nil {
		return err
	}
	if httpResp.StatusCode < 200 || httpResp.StatusCode > 299 {
		return normalizeHTTPError(provider, httpResp.StatusCode, data)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s: decode response: %w", provider, err)
	}
	return nil
}

func normalizeHTTPError(provider string, status int, data []byte) error {
	var envelope struct {
		Error struct {
			Type    string `json:"type"`
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &envelope)
	code := envelope.Error.Code
	if code == "" {
		code = envelope.Error.Type
	}
	message := envelope.Error.Message
	if message == "" {
		message = strings.TrimSpace(string(data))
	}
	if message == "" {
		message = http.StatusText(status)
	}
	return &ProviderError{Provider: provider, Status: status, Code: code, Message: message}
}

func endpoint(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func systemText(messages []Message) string {
	var parts []string
	for _, m := range messages {
		if m.Role == RoleSystem && m.Content != "" {
			parts = append(parts, m.Content)
		}
	}
	return strings.Join(parts, "\n")
}

func toolIDByName(tools []Tool) map[string]string {
	ids := make(map[string]string, len(tools))
	for _, t := range tools {
		ids[t.Name] = t.ID
	}
	return ids
}

func toolNameByID(tools []Tool) map[string]string {
	names := make(map[string]string, len(tools))
	for _, t := range tools {
		names[t.ID] = t.Name
	}
	return names
}

func openAIInput(messages []Message, tools []Tool) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	names := toolNameByID(tools)
	for _, m := range messages {
		if m.Role == RoleAssistant && len(m.ToolCalls) > 0 {
			for _, c := range m.ToolCalls {
				name := c.ToolID
				if names[name] != "" {
					name = names[name]
				}
				out = append(out, map[string]any{
					"type":      "function_call",
					"call_id":   c.ID,
					"name":      name,
					"arguments": marshalString(c.Arguments),
				})
			}
			continue
		}
		if m.Role == RoleTool {
			out = append(out, map[string]any{
				"type":    "function_call_output",
				"call_id": m.ToolCallID,
				"output":  m.Content,
			})
			continue
		}
		out = append(out, map[string]any{"role": string(m.Role), "content": m.Content})
	}
	return out
}

func openAITools(tools []Tool) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		out = append(out, map[string]any{
			"type":        "function",
			"name":        t.Name,
			"description": t.Description,
			"parameters":  t.InputSchema,
		})
	}
	return out
}

type openAIResponse struct {
	OutputText string `json:"output_text"`
	Output     []struct {
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
		Content   []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"output"`
	Usage struct {
		InputTokens        int `json:"input_tokens"`
		OutputTokens       int `json:"output_tokens"`
		InputTokensDetails struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"input_tokens_details"`
	} `json:"usage"`
	Status string `json:"status"`
}

func (r openAIResponse) normalize(tools []Tool) (Response, error) {
	var text []string
	var calls []ToolCall
	ids := toolIDByName(tools)
	if r.OutputText != "" {
		text = append(text, r.OutputText)
	}
	for i, item := range r.Output {
		switch item.Type {
		case "message":
			for _, c := range item.Content {
				if c.Text != "" {
					text = append(text, c.Text)
				}
			}
		case "function_call":
			name := item.Name
			if ids[name] != "" {
				name = ids[name]
			}
			arguments, err := parseObject(item.Arguments)
			if err != nil {
				return Response{}, fmt.Errorf("openai: invalid arguments for %s: %w", name, err)
			}
			calls = append(calls, ToolCall{
				ID:        fallback(item.CallID, fmt.Sprintf("openai-call-%d", i)),
				ToolID:    name,
				Arguments: arguments,
			})
		}
	}
	return Response{
		Text:      strings.Join(text, ""),
		ToolCalls: calls,
		Usage: Usage{
			InputTokens:  r.Usage.InputTokens,
			OutputTokens: r.Usage.OutputTokens,
			CachedTokens: r.Usage.InputTokensDetails.CachedTokens,
		},
		FinishReason: r.Status,
	}, nil
}

func anthropicMessages(messages []Message, tools []Tool) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	names := toolNameByID(tools)
	for _, m := range messages {
		switch m.Role {
		case RoleSystem:
			continue
		case RoleTool:
			out = append(out, map[string]any{
				"role": "user",
				"content": []map[string]any{{
					"type":        "tool_result",
					"tool_use_id": m.ToolCallID,
					"content":     m.Content,
				}},
			})
		case RoleAssistant:
			if len(m.ToolCalls) == 0 {
				out = append(out, map[string]any{"role": "assistant", "content": m.Content})
				continue
			}
			content := []map[string]any{}
			if m.Content != "" {
				content = append(content, map[string]any{"type": "text", "text": m.Content})
			}
			for _, c := range m.ToolCalls {
				name := c.ToolID
				if names[name] != "" {
					name = names[name]
				}
				content = append(content, map[string]any{
					"type":  "tool_use",
					"id":    c.ID,
					"name":  name,
					"input": c.Arguments,
				})
			}
			out = append(out, map[string]any{"role": "assistant", "content": content})
		default:
			out = append(out, map[string]any{"role": string(m.Role), "content": m.Content})
		}
	}
	return out
}

func anthropicTools(tools []Tool) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		out = append(out, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": t.InputSchema,
		})
	}
	return out
}

type anthropicResponse struct {
	Content []struct {
		Type  string         `json:"type"`
		Text  string         `json:"text"`
		ID    string         `json:"id"`
		Name  string         `json:"name"`
		Input map[string]any `json:"input"`
	} `json:"content"`
	Usage struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	} `json:"usage"`
	StopReason string `json:"stop_reason"`
}

func (r anthropicResponse) normalize(tools []Tool) (Response, error) {
	var text []string
	var calls []ToolCall
	ids := toolIDByName(tools)
	for i, item := range r.Content {
		switch item.Type {
		case "text":
			text = append(text, item.Text)
		case "tool_use":
			name := item.Name
			if ids[name] != "" {
				name = ids[name]
			}
			calls = append(calls, ToolCall{
				ID:        fallback(item.ID, fmt.Sprintf("anthropic-call-%d", i)),
				ToolID:    name,
				Arguments: item.Input,
			})
		}
	}
	return Response{
		Text:      strings.Join(text, ""),
		ToolCalls: calls,
		Usage: Usage{
			InputTokens:  r.Usage.InputTokens,
			OutputTokens: r.Usage.OutputTokens,
			CachedTokens: r.Usage.CacheReadInputTokens + r.Usage.CacheCreationInputTokens,
		},
		FinishReason: r.StopReason,
	}, nil
}

func marshalString(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

func parseObject(s string) (map[string]any, error) {
	var out map[string]any
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil, err
	}
	if out == nil {
		return nil, errors.New("arguments must be a JSON object")
	}
	return out, nil
}

func fallback(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
