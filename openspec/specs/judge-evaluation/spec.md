## ADDED Requirements

### Requirement: External judge LLM evaluation with Hermes-aligned prompts

The system SHALL call a dedicated lightweight LLM (claude-haiku-4-5 or gpt-4o-mini) with temperature=0 to evaluate goal completion. The judge MUST be a separate model from the main agent model. The system prompt and user prompt templates MUST match Hermes source verbatim.

#### Scenario: Judge called with correct parameters
- **WHEN** `evaluateWithJudge` is invoked with a non-empty assistant response
- **THEN** system calls `streamSimple` with temperature=0, timeoutMs=30000, signal=ctx.signal, maxTokens=4096, using a model found via `ctx.modelRegistry.find`

#### Scenario: Judge system prompt matches Hermes verbatim
- **WHEN** judge is called
- **THEN** the system prompt includes the three OR paths for DONE (explicit confirmation, final deliverable produced, blocked/unreachable/needs user input) and requires single-line JSON output `{"done": bool, "reason": str}`

### Requirement: Judge DONE verdict includes blocked/unreachable as completion

The system SHALL treat blocked, unreachable, or needs-user-input states as DONE (per Hermes design), preventing the agent from spinning on impossible objectives.

#### Scenario: Blocked goal judged as done
- **WHEN** agent response indicates the goal is blocked or needs user input
- **THEN** judge returns done=true with reason describing the block, and system sets status="done"

### Requirement: Judge output parsed with 3-tier fallback

The system SHALL attempt to parse judge output using three strategies in order: (1) clean JSON parse, (2) markdown fence extraction, (3) regex search for embedded JSON object. Only if all three fail is the result marked as parseFailed.

#### Scenario: Clean JSON parsed successfully
- **WHEN** judge outputs `{"done": true, "reason": "goal complete"}`
- **THEN** parseFailed=false, done=true, reason="goal complete"

#### Scenario: Markdown fence JSON parsed successfully
- **WHEN** judge outputs a markdown code block containing valid JSON with done and reason fields
- **THEN** parseFailed=false, values extracted from fenced JSON

#### Scenario: Embedded JSON found via regex
- **WHEN** judge outputs prose with an embedded `{..."done"..."reason"...}` object
- **THEN** parseFailed=false, values extracted from the matched JSON object

#### Scenario: All parse strategies fail
- **WHEN** judge output contains no parseable JSON with done and reason fields
- **THEN** parseFailed=true, verdict defaults to "continue" (fail-open)

### Requirement: Judge content truncation matches Hermes limits

The system SHALL truncate goal text to 2000 characters, assistant response to 4000 characters, and subgoals block to 2000 characters before sending to the judge.

#### Scenario: Long response truncated
- **WHEN** assistant response exceeds 4000 characters
- **THEN** only the first 3997 characters plus "..." are sent to the judge

### Requirement: No silent fallback to main agent model

The system SHALL NOT silently use `ctx.model` (the main agent model) as the judge. If no dedicated lightweight model is available via `ctx.modelRegistry.find`, the system SHALL fail-open with verdict="continue" and reason="no judge model available".

#### Scenario: No judge model found
- **WHEN** `ctx.modelRegistry.find` returns null for both anthropic/claude-haiku-4-5 and openai/gpt-4o-mini
- **THEN** evaluate returns verdict="continue", parseFailed=false (does NOT increment failure counter)

#### Scenario: API key unavailable for judge model
- **WHEN** `ctx.modelRegistry.getApiKeyAndHeaders` returns `{ ok: false }`
- **THEN** evaluate returns verdict="continue", reason=auth.error, parseFailed=false

### Requirement: Transport errors are fail-open without counter increment

The system SHALL treat API/transport errors (network failures, timeouts, HTTP errors) as fail-open: verdict="continue" without incrementing the consecutive parse failure counter.

#### Scenario: Judge API timeout
- **WHEN** streamSimple exceeds 30s timeout
- **THEN** verdict="continue", parseFailed=false, consecutiveParseFailures unchanged

#### Scenario: Network error during judge call
- **WHEN** streamSimple throws a network error
- **THEN** verdict="continue", reason="judge API error", parseFailed=false

### Requirement: Consecutive parse failure circuit breaker

The system SHALL count consecutive parse failures (responses received but unparseable). Upon reaching 3 consecutive failures, the system SHALL auto-pause the goal. One successful parse SHALL reset the counter to 0.

#### Scenario: First two parse failures continue
- **WHEN** judge produces unparseable output for the 1st and 2nd consecutive time
- **THEN** verdict="continue", consecutiveParseFailures incremented, goal remains active

#### Scenario: Third consecutive parse failure triggers pause
- **WHEN** judge produces unparseable output for the 3rd consecutive time
- **THEN** status transitions to "paused" with pausedReason indicating judge output issues

#### Scenario: Successful parse resets counter
- **WHEN** judge produces parseable output after 1 or 2 consecutive failures
- **THEN** consecutiveParseFailures resets to 0

### Requirement: turnsUsed incremented BEFORE judge call

The system SHALL increment `turnsUsed` before calling the judge LLM, ensuring the turn is counted even if the judge call fails.

#### Scenario: Turn counted regardless of judge outcome
- **WHEN** evaluateWithJudge is invoked
- **THEN** turnsUsed is incremented as the FIRST operation, before any judge API call
