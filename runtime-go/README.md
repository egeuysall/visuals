# Navo Go runtime

Standard-library Go runtime for bounded tool scheduling and direct OpenAI or
Anthropic HTTP adapters.

```bash
go get github.com/egeuysall/sdk/runtime-go
```

Run the package checks from this directory:

```bash
go test -race ./...
go vet ./...
```

The scheduler runs read-only tasks concurrently within `MaxConcurrency`,
serializes writes, honors dependencies, and cancels sibling reads after the
first failure. Provider requests inherit the caller's `context.Context`.
