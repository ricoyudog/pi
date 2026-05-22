## ADDED Requirements

### Requirement: Continuation triggered at agent_end not turn_end

The system SHALL invoke judge evaluation and queue continuation only in the `agent_end` event handler, NOT in `turn_end`. The `turn_end` handler SHALL only capture the latest assistant content and metadata for later use.

#### Scenario: Tool-call chain produces multiple turn_end but single agent_end
- **WHEN** agent performs a multi-tool-call chain (3 tool calls in sequence)
- **THEN** `turn_end` fires 3 times (only updating lastAssistantContent each time), but judge evaluation runs exactly once at `agent_end`

#### Scenario: turn_end only stores content
- **WHEN** `turn_end` fires during an active goal
- **THEN** handler stores lastAssistantContent, lastAssistantStopReason, and lastAssistantErrorMessage without calling judge or queueing continuation

### Requirement: Continuation uses idle macrotask with retry

The system SHALL inject continuation messages via `setTimeout(..., 0)` after `agent_end` returns, with `ctx.isIdle()` polling (max 10 retries) before sending. Direct injection inside `agent_end` handler is forbidden.

#### Scenario: Continuation sent after agent enters idle
- **WHEN** judge returns "continue" in agent_end handler
- **THEN** system schedules setTimeout(0), checks ctx.isIdle(), and upon idle sends pi.sendMessage with deliverAs="followUp" and triggerTurn=true

#### Scenario: Agent not immediately idle after agent_end
- **WHEN** ctx.isIdle() returns false on first check after setTimeout(0)
- **THEN** system retries via additional setTimeout(0) up to 10 attempts, sending only when idle is confirmed

#### Scenario: Max retry exhausted
- **WHEN** ctx.isIdle() returns false for all 10 retry attempts
- **THEN** continuation is abandoned (continuationQueued reset to false), no message sent

### Requirement: Continuation message delivered as user-role via custom followUp

The system SHALL send continuation prompts using `pi.sendMessage({ customType: "pi-goal-hermes:continuation", content, display: true, details }, { deliverAs: "followUp", triggerTurn: true })`. The custom message MUST appear as a user-role message in the LLM context via Pi's `convertToLlm()`.

#### Scenario: Continuation message payload shape
- **WHEN** continuation is sent
- **THEN** payload is exactly `{ customType: "pi-goal-hermes:continuation", content: [{type: "text", text: prompt}], display: true, details: { goalId } }` with options `{ deliverAs: "followUp", triggerTurn: true }`

#### Scenario: Continuation appears as user-role in LLM
- **WHEN** continuation message enters the LLM context
- **THEN** it is converted to a user-role message (not system, not assistant)

### Requirement: Stale continuation guard prevents orphaned messages

The system SHALL verify goal validity before sending any queued continuation. A continuation MUST be abandoned if: goal is null, goal.id does not match the queued goalId, goal.status is not "active", or ctx.hasPendingMessages() is true.

#### Scenario: Goal cleared before continuation fires
- **WHEN** user issues `/goal clear` between agent_end and the idle macrotask firing
- **THEN** the queued continuation detects goal=null and abandons without sending

#### Scenario: New goal set before continuation fires
- **WHEN** user sets a new goal (new id) between agent_end and macrotask
- **THEN** the queued continuation detects goal.id mismatch and abandons

#### Scenario: User message queued before continuation fires
- **WHEN** user sends a message between agent_end and macrotask
- **THEN** ctx.hasPendingMessages() returns true, continuation is abandoned

### Requirement: Duplicate continuation prevention

The system SHALL maintain a `continuationQueued` flag that prevents multiple continuations from being scheduled for the same agent_end cycle.

#### Scenario: Only one continuation per agent_end
- **WHEN** evaluateWithJudge returns shouldContinue=true
- **THEN** queueContinuation sets continuationQueued=true, and subsequent calls within the same cycle are no-ops

#### Scenario: Flag reset after send or abandon
- **WHEN** continuation is either sent successfully or abandoned (stale/exhausted)
- **THEN** continuationQueued is reset to false, allowing future continuations

### Requirement: User messages take priority over continuation

The system SHALL skip judge evaluation and continuation injection when `ctx.hasPendingMessages()` returns true at the start of `agent_end` handler, allowing user-initiated messages to be processed first.

#### Scenario: Pending user message skips judge
- **WHEN** agent_end fires and ctx.hasPendingMessages() is true
- **THEN** judge is NOT called, no continuation is queued, agent processes user message next

### Requirement: Empty assistant response skips judge and continuation

The system SHALL NOT call the judge or increment turnsUsed when the last assistant response is empty (whitespace-only).

#### Scenario: Empty response produces no action
- **WHEN** agent_end fires and lastAssistantContent.trim() is empty
- **THEN** no judge call, no turnsUsed increment, no continuation queued

### Requirement: Error/aborted response triggers auto-pause

The system SHALL NOT call the judge when the last assistant response has stopReason="error" or "aborted", or when errorMessage is present. Instead, the goal SHALL be paused with the error information.

#### Scenario: Error response auto-pauses goal
- **WHEN** agent_end fires and lastAssistantStopReason is "error"
- **THEN** goal transitions to paused with pausedReason containing the error info, no judge call

#### Scenario: Aborted response auto-pauses goal
- **WHEN** agent_end fires and lastAssistantStopReason is "aborted"
- **THEN** goal transitions to paused with pausedReason="assistant aborted", no judge call

### Requirement: Ctrl+C / signal abort triggers auto-pause

The system SHALL auto-pause the goal when `ctx.signal?.aborted` is true at the start of `agent_end` handler.

#### Scenario: Aborted signal pauses goal
- **WHEN** agent_end fires and ctx.signal.aborted is true
- **THEN** goal transitions to paused with pausedReason="turn interrupted", no judge call, no continuation

### Requirement: maxTurns budget enforcement

The system SHALL pause the goal when `turnsUsed >= maxTurns` after incrementing the turn counter, preventing infinite continuation loops.

#### Scenario: Budget exhausted triggers pause
- **WHEN** turnsUsed reaches maxTurns after increment
- **THEN** status transitions to "paused" with pausedReason indicating budget exhaustion, no continuation queued

#### Scenario: Budget check happens after turns increment but after judge
- **WHEN** judge returns "continue" and turnsUsed now equals maxTurns
- **THEN** budget check fires, goal is paused (judge verdict is recorded but continuation is not sent)
