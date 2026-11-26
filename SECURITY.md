# Security

Please do not report security vulnerabilities in public issues. Send a private
report to the repository maintainers with a description, reproduction steps,
impact, and suggested mitigation.

The local gateway binds to `127.0.0.1` by default. Do not expose it publicly
without authentication, TLS, rate limiting, and an explicit tool allowlist.
Tool arguments are validated before execution, but tool implementations remain
application code and must enforce their own authorization at the trust boundary.
