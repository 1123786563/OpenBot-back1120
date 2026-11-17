// Package main is OpenBot's billing gate as a Bifrost Go plugin.
//
// Every model request that reaches Bifrost is refused here unless it presents a correlation ID
// the deployment's billing ledger holds a live reservation for: the gate calls the ledger's
// verify before the provider is asked anything, so an unreserved request never leaves the
// gateway. After the provider answers, what the call actually used is settled on the price the
// reservation locked, and a reservation that was never settled is released.
//
// The ID travels as the `x-openbot-correlation-id` header, put there by OpenBot's
// agent-claude-sdk harness from the server's `forwardedProps.openbotCorrelationId` (see
// `server/src/billing-gateway.ts`). A caller who cannot present one — a harness started outside
// OpenBot, a replayed header, a direct curl at the gateway — is refused with 402 and the
// provider's request count stays at zero.
//
// Built and loaded per docs/plugins/writing-go-plugin.mdx of the pinned Bifrost release: the
// .so must be built with the same Go toolchain as the Bifrost binary and configured in
// `config.json` under `plugins`. See ../README.md for the pinned procedure.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// The header the harness puts the server's correlation ID on.
const correlationHeader = "x-openbot-correlation-id"

// The ledger contract this gate speaks, one seam behind OpenBot's own client
// (`server/src/billing-gateway.ts`), so both sides move together.
const (
	verifyPath  = "/api/internal/billing/reservations/verify"
	settlePath  = "/api/internal/billing/reservations/settle"
	releasePath = "/api/internal/billing/reservations/release"
)

// config is the plugin's block in Bifrost's config.json.
type config struct {
	// LedgerURL is the OpenBot internal billing seam, e.g. http://host.docker.internal:3001.
	LedgerURL string `json:"ledger_url"`
	// LedgerToken is a shared secret the ledger requires; optional, and never logged.
	LedgerToken string `json:"ledger_token,omitempty"`
	// TimeoutMs bounds each ledger call. Zero means five seconds.
	TimeoutMs int `json:"timeout_ms,omitempty"`
	// RefuseStatus is what an unreserved request is refused with. Default 402.
	RefuseStatus int `json:"refuse_status,omitempty"`
}

type gate struct {
	ledgerURL    string
	ledgerToken  string
	timeoutMs    int
	refuseStatus int
	client       *http.Client
}

var (
	mu   sync.RWMutex
	self *gate
)

// Init is called when Bifrost loads the plugin, with this plugin's config block.
func Init(config any) error {
	parsed, ok := config.(map[string]any)
	if !ok {
		return fmt.Errorf("billing gate: config must be an object")
	}
	read := func(key string) string {
		if value, ok := parsed[key].(string); ok {
			return strings.TrimSpace(value)
		}
		return ""
	}
	ledgerURL := strings.TrimRight(read("ledger_url"), "/")
	if ledgerURL == "" {
		return fmt.Errorf("billing gate: ledger_url is required")
	}
	refuse := 402
	if parsed["refuse_status"] != nil {
		if status, ok := parsed["refuse_status"].(float64); ok && int(status) != 0 {
			refuse = int(status)
		}
	}
	timeout := 5000
	if parsed["timeout_ms"] != nil {
		if ms, ok := parsed["timeout_ms"].(float64); ok && int(ms) != 0 {
			timeout = int(ms)
		}
	}
	newGate := &gate{
		ledgerURL:    ledgerURL,
		ledgerToken:  read("ledger_token"),
		timeoutMs:    timeout,
		refuseStatus: refuse,
		client: &http.Client{
			Timeout: time.Duration(timeout) * time.Millisecond,
		},
	}
	mu.Lock()
	self = newGate
	mu.Unlock()
	return nil
}

// GetName returns the plugin's identifier in Bifrost's logs and UI.
func GetName() string { return "openbot-billing-gate" }

// Cleanup flushes nothing: every ledger call is synchronous.
func Cleanup() error { return nil }

// current returns the gate Init built, or nil before it.
func current() *gate {
	mu.RLock()
	defer mu.RUnlock()
	return self
}

// HTTPTransportPreHook is the request boundary: before Bifrost core, before the provider.
//
// A request without a live reservation under the correlation header is answered here and never
// reaches a provider — this is what makes the check un-bypassable from the harness side, whatever
// the SDK retries, streams or resumes on its own.
func HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	g := current()
	if g == nil {
		return refuse(503, "billing gate is not initialised"), nil
	}
	correlation := req.CaseInsensitiveHeaderLookup(correlationHeader)
	if strings.TrimSpace(correlation) == "" {
		return g.refuse(ctx, "no correlation id on the request"), nil
	}
	record, err := g.callLedger(verifyPath, map[string]any{"correlationId": correlation}, correlation)
	if err != nil {
		// Fail closed: an unreachable ledger refuses, it never waves a request through.
		return g.refuse(ctx, fmt.Sprintf("reservation could not be confirmed: %v", err)), nil
	}
	reservationID, _ := record["reservationId"].(string)
	state, _ := record["finalState"].(string)
	if reservationID == "" || state != "reserved" {
		return g.refuse(ctx, fmt.Sprintf("no live reservation for this correlation id (state %q)", state)), nil
	}
	// The settlement reads this back after the provider answers.
	ctx.SetValue(schemas.BifrostContextKey("openbot_reservation_id"), reservationID)
	ctx.SetValue(schemas.BifrostContextKey("openbot_correlation_id"), correlation)
	return nil, nil
}

// PostLLMHook settles what the provider answered with, on the reservation the pre-hook confirmed.
//
// Usage arrives on the response the provider gave; what it did not spend of the reservation is
// released. A settle that the ledger refuses is released too, with the reason carried so the
// run's ledger row says what happened rather than silently keeping a hold.
func PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	g := current()
	if g == nil {
		return resp, bifrostErr, nil
	}
	reservation, _ := ctx.Value(schemas.BifrostContextKey("openbot_reservation_id")).(string)
	correlation, _ := ctx.Value(schemas.BifrostContextKey("openbot_correlation_id")).(string)
	if reservation == "" || correlation == "" {
		// The pre-hook refused this request; nothing was reserved, so nothing settles.
		return resp, bifrostErr, nil
	}
	if bifrostErr != nil {
		// The provider refused or the call failed: give the hold back in full.
		g.release(reservation, correlation, "provider error before settlement")
		return resp, bifrostErr, nil
	}
	input, output := usageOf(resp)
	if input == 0 && output == 0 {
		g.release(reservation, correlation, "no usage reported by the provider")
		return resp, bifrostErr, nil
	}
	if _, err := g.callLedger(settlePath, map[string]any{
		"reservationId":      reservation,
		"correlationId":      correlation,
		"actualInputTokens":  input,
		"actualOutputTokens": output,
		// Amount is the ledger's to compute on the price the reservation locked; the gate sends
		// the measured usage and the ledger answers with the settled record.
	}, correlation); err != nil {
		g.release(reservation, correlation, fmt.Sprintf("settle refused: %v", err))
	}
	return resp, bifrostErr, nil
}

// usageOf reads the token counts off whatever the provider answered with. NormalizedUsage is the
// one accessor that covers every response shape — text completion, chat, responses, embeddings —
// so the settlement does not care which protocol the request arrived in.
func usageOf(resp *schemas.BifrostResponse) (int, int) {
	if resp == nil {
		return 0, 0
	}
	usage := resp.NormalizedUsage()
	if usage == nil {
		return 0, 0
	}
	return usage.PromptTokens, usage.CompletionTokens
}

// refuse answers the client at the gateway. The provider is not called.
func (g *gate) refuse(ctx *schemas.BifrostContext, reason string) *schemas.HTTPResponse {
	if ctx != nil {
		ctx.Log(schemas.LogLevelWarn, fmt.Sprintf("openbot billing gate refused a request: %s", reason))
	}
	return refuse(g.refuseStatus, reason)
}

func refuse(status int, reason string) *schemas.HTTPResponse {
	body, _ := json.Marshal(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    "billing_reservation_required",
			"message": reason,
		},
	})
	return &schemas.HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"content-type": "application/json"},
		Body:       body,
	}
}

// callLedger posts one seam call and decodes the ledger's record. The token is sent, never logged.
func (g *gate) callLedger(path string, payload map[string]any, idempotencyKey string) (map[string]any, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, g.ledgerURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("idempotency-key", idempotencyKey)
	if g.ledgerToken != "" {
		request.Header.Set("authorization", "Bearer "+g.ledgerToken)
	}
	response, err := g.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var record map[string]any
	decoded := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoded.Decode(&record); err != nil {
		return nil, fmt.Errorf("the ledger answered %d with a body that is not a record", response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("the ledger answered %d", response.StatusCode)
	}
	return record, nil
}

// release gives a hold back. A refused release is logged loudly and left to the ledger's own
// expiry, and to the restart recovery OpenBot's side runs (see `billing-gateway.ts`).
func (g *gate) release(reservation, correlation, reason string) {
	if _, err := g.callLedger(releasePath, map[string]any{
		"reservationId": reservation,
		"correlationId": correlation,
		"reason":        reason,
	}, correlation); err != nil {
		fmt.Fprintf(os.Stderr, "openbot billing gate: release refused for %s: %v\n", reservation, err)
	}
}
