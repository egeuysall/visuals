package runtimego

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenAIAdapterNormalizesToolCallsUsageAndHeaders(t *testing.T) {
	var auth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "gpt-test" {
			t.Fatalf("model = %v", body["model"])
		}
		_, _ = w.Write([]byte(`{
			"status":"completed",
			"output":[
				{"type":"message","content":[{"type":"output_text","text":"done"}]},
				{"type":"function_call","call_id":"c1","name":"lookup","arguments":"{\"key\":\"x\"}"}
			],
			"usage":{"input_tokens":2,"output_tokens":3,"input_tokens_details":{"cached_tokens":1}}
		}`))
	}))
	defer server.Close()

	resp, err := (OpenAIAdapter{APIKey: "key", URL: server.URL, Client: server.Client()}).Generate(context.Background(), Request{
		Model:    "gpt-test",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools: []Tool{{ID: "crm/lookup", Name: "lookup", InputSchema: map[string]any{
			"type": "object",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer key" {
		t.Fatalf("auth header = %q", auth)
	}
	if resp.Text != "done" || resp.ToolCalls[0].ToolID != "crm/lookup" || resp.ToolCalls[0].Arguments["key"] != "x" {
		t.Fatalf("bad response: %+v", resp)
	}
	if resp.Usage != (Usage{InputTokens: 2, OutputTokens: 3, CachedTokens: 1}) {
		t.Fatalf("bad usage: %+v", resp.Usage)
	}
}

func TestAnthropicAdapterNormalizesToolCallsUsageAndErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "key" || r.Header.Get("anthropic-version") == "" {
			t.Fatalf("missing auth/version headers")
		}
		_, _ = w.Write([]byte(`{
			"content":[
				{"type":"text","text":"checking"},
				{"type":"tool_use","id":"c1","name":"lookup","input":{"key":"x"}}
			],
			"usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":4},
			"stop_reason":"tool_use"
		}`))
	}))
	defer server.Close()

	resp, err := (AnthropicAdapter{APIKey: "key", URL: server.URL, Client: server.Client()}).Generate(context.Background(), Request{
		Model:    "claude-test",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools:    []Tool{{ID: "crm/lookup", Name: "lookup"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Text != "checking" || resp.ToolCalls[0].ToolID != "crm/lookup" || resp.Usage.CachedTokens != 4 {
		t.Fatalf("bad response: %+v", resp)
	}

	errorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"type":"invalid_request_error","message":"bad request"}}`, http.StatusBadRequest)
	}))
	defer errorServer.Close()
	_, err = (AnthropicAdapter{APIKey: "key", URL: errorServer.URL, Client: errorServer.Client()}).Generate(context.Background(), Request{Model: "x"})
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || providerErr.Status != http.StatusBadRequest || providerErr.Code != "invalid_request_error" {
		t.Fatalf("bad error: %#v", err)
	}
}

func TestAdapterUsesContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (OpenAIAdapter{APIKey: "key", URL: "http://127.0.0.1:1"}).Generate(ctx, Request{Model: "x"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func TestOpenAIAdapterRejectsMalformedToolArguments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"output":[{"type":"function_call","name":"lookup","arguments":"not-json"}]}`))
	}))
	defer server.Close()

	_, err := (OpenAIAdapter{APIKey: "key", URL: server.URL, Client: server.Client()}).Generate(context.Background(), Request{Model: "gpt-test"})
	if err == nil || !strings.Contains(err.Error(), "invalid arguments") {
		t.Fatalf("expected malformed arguments error, got %v", err)
	}
}
