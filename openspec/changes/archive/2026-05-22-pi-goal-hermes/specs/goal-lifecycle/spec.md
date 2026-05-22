## ADDED Requirements

### Requirement: Goal state machine with correct status transitions

The system SHALL maintain a `PiLocalGoalState` with status values `active`, `paused`, `done`, and `cleared`. Status transitions SHALL follow the defined state graph: active can transition to paused/done/cleared; paused can transition to active/cleared; done can transition to cleared. No other transitions are valid.

#### Scenario: New goal creates active state
- **WHEN** user issues `/goal <text>` with no existing active goal
- **THEN** system creates a new PiLocalGoalState with status="active", turnsUsed=0, maxTurns=20, empty subgoals, a unique id, and persists it via appendEntry

#### Scenario: New goal replaces existing active goal after confirmation
- **WHEN** user issues `/goal <text>` while an active goal exists
- **THEN** system prompts for confirmation, and if confirmed, creates a new goal with a new id (invalidating any stale continuations from the old goal)

#### Scenario: Goal state persisted to session entries
- **WHEN** any state transition occurs (set, pause, resume, done, clear)
- **THEN** system calls `pi.appendEntry("pi-goal-hermes:state", { goal: state })` with the updated state including `updatedAt` timestamp

### Requirement: Slash command /goal pause stops continuation loop

The system SHALL stop the auto-continuation loop when the user issues `/goal pause` or `/goal stop`, setting status to "paused" with the appropriate reason.

#### Scenario: User pauses active goal
- **WHEN** user issues `/goal pause` while goal status is "active"
- **THEN** status transitions to "paused" with pausedReason="user pause", state is persisted, no further continuations are queued

#### Scenario: User stops active goal
- **WHEN** user issues `/goal stop` while goal status is "active"
- **THEN** status transitions to "paused" with pausedReason="user stop", state is persisted, no further continuations are queued

### Requirement: Slash command /goal resume resets counters and restarts loop

The system SHALL resume a paused goal by resetting `turnsUsed` to 0 and `consecutiveParseFailures` to 0, then queueing a continuation if the agent is idle.

#### Scenario: Resume resets counters
- **WHEN** user issues `/goal resume` while goal status is "paused"
- **THEN** turnsUsed is set to 0, consecutiveParseFailures is set to 0, status transitions to "active"

#### Scenario: Resume queues continuation when idle
- **WHEN** user issues `/goal resume` and agent is currently idle
- **THEN** a continuation prompt is queued via the idle macrotask mechanism

### Requirement: Slash command /goal done marks Pi-local completion

The system SHALL allow the user to manually mark a goal as done via `/goal done`.

#### Scenario: User marks goal done
- **WHEN** user issues `/goal done` while a goal exists (active or paused)
- **THEN** status transitions to "done", lastVerdict is set to "done", lastReason is set to "marked done by user", state is persisted

### Requirement: Slash command /goal clear removes goal with terminal persistence

The system SHALL persist a "cleared" terminal state before nullifying the runtime goal pointer, ensuring reload recovery does not resurrect a cleared goal.

#### Scenario: Clear persists terminal state then nullifies
- **WHEN** user issues `/goal clear`
- **THEN** system appends an entry with status="cleared", THEN sets runtime goal pointer to null

#### Scenario: Cleared goal not restored on session reload
- **WHEN** session starts and latest goal entry has status="cleared"
- **THEN** `latestStateFromSession` returns null, no goal is active

### Requirement: Goal state recovery on session start

The system SHALL recover the latest PiLocalGoalState from session custom entries on `session_start`, scanning from the leaf entry backward using the current branch.

#### Scenario: Active goal restored on normal session start
- **WHEN** session starts with reason != "reload" and latest entry has status="active"
- **THEN** goal is restored to active state with all fields intact

#### Scenario: Active goal auto-paused on reload
- **WHEN** session starts with reason="reload" and latest entry has status="active"
- **THEN** goal transitions to "paused" with appropriate notification, preventing silent auto-continuation after reload

#### Scenario: Branch-aware recovery
- **WHEN** session has forked and entries exist on multiple branches
- **THEN** recovery uses `ctx.sessionManager.getBranch()` to scan only the current leaf branch

### Requirement: Goal status display

The system SHALL display current goal information when `/goal status` or `/goal` (no args) is issued.

#### Scenario: Status shows goal details
- **WHEN** user issues `/goal status` with an active goal
- **THEN** system displays: goal text, current status, turnsUsed/maxTurns progress, last verdict and reason

#### Scenario: No goal set
- **WHEN** user issues `/goal status` with no goal set
- **THEN** system displays usage instructions
