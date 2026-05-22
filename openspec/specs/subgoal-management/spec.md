## ADDED Requirements

### Requirement: /subgoal command adds extra acceptance criteria

The system SHALL allow users to add mid-loop acceptance criteria via `/subgoal <text>`. Each subgoal is appended to the goal's `subgoals` array and persisted immediately.

#### Scenario: Add subgoal to active goal
- **WHEN** user issues `/subgoal write tests for all functions` while a goal is active
- **THEN** "write tests for all functions" is appended to subgoals array, state is persisted, confirmation shown

#### Scenario: Add subgoal with no goal set
- **WHEN** user issues `/subgoal <text>` with no goal set
- **THEN** system shows warning "No goal is set."

### Requirement: /subgoal list displays numbered criteria

The system SHALL display all current subgoals as a numbered list when `/subgoal list` or `/subgoal` (no args) is issued.

#### Scenario: List subgoals
- **WHEN** user issues `/subgoal list` with 3 subgoals set
- **THEN** system displays: "1. first\n2. second\n3. third"

#### Scenario: List empty subgoals
- **WHEN** user issues `/subgoal list` with no subgoals
- **THEN** system displays "No subgoals."

### Requirement: /subgoal remove deletes by 1-based index

The system SHALL remove a specific subgoal by its 1-based index number.

#### Scenario: Remove valid index
- **WHEN** user issues `/subgoal remove 2` with 3 subgoals
- **THEN** the second subgoal is removed, remaining subgoals re-indexed, state persisted

#### Scenario: Remove invalid index
- **WHEN** user issues `/subgoal remove 5` with only 3 subgoals
- **THEN** system shows warning "Subgoal index out of range."

### Requirement: /subgoal clear removes all criteria

The system SHALL clear all subgoals when `/subgoal clear` is issued.

#### Scenario: Clear all subgoals
- **WHEN** user issues `/subgoal clear`
- **THEN** subgoals array is emptied, state persisted, confirmation shown

### Requirement: Subgoals modify judge evaluation prompt

The system SHALL use the subgoal-aware judge user prompt template when subgoals are present. This template includes numbered criteria and requires specific evidence for each criterion.

#### Scenario: Judge prompt includes subgoals when present
- **WHEN** judge is called and goal has 2 subgoals
- **THEN** judge user prompt uses the subgoals template with numbered criteria and explicit instruction to require specific evidence per criterion

#### Scenario: Judge prompt uses basic template when no subgoals
- **WHEN** judge is called and goal has 0 subgoals
- **THEN** judge user prompt uses the basic template (goal + response only)

### Requirement: Subgoals require specific evidence for DONE

The judge user prompt with subgoals SHALL explicitly instruct the judge to require concrete evidence (file excerpts, command output, specific text) for each criterion. Generic phrases like "all requirements met" SHALL NOT satisfy the evidence requirement.

#### Scenario: Judge rejects generic completion claim
- **WHEN** agent response says "all criteria are met" without specific evidence per criterion
- **THEN** judge returns done=false (the prompt instructs: "Do not accept generic phrases... require specific evidence")

### Requirement: Continuation prompt includes subgoals

The continuation prompt template SHALL include all current subgoals when present, instructing the agent to work toward both the main goal AND all additional criteria.

#### Scenario: Continuation with subgoals
- **WHEN** continuation prompt is generated for a goal with 2 subgoals
- **THEN** prompt includes the goal text, lists additional criteria, and instructs: "Continue working toward the goal AND all additional criteria"

#### Scenario: Continuation without subgoals
- **WHEN** continuation prompt is generated for a goal with 0 subgoals
- **THEN** prompt includes only the goal text and basic continuation instruction

### Requirement: Subgoals truncated in judge prompt

The system SHALL truncate the combined subgoals block to 2000 characters before sending to the judge, consistent with Hermes truncation limits.

#### Scenario: Long subgoals truncated
- **WHEN** combined subgoals text exceeds 2000 characters
- **THEN** only the first 1997 characters plus "..." are sent to the judge
