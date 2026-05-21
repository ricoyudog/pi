import { streamSimple, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const JUDGE_SYSTEM_PROMPT = `You are a strict judge evaluating whether an autonomous agent has achieved a user's stated goal. You receive the goal text and the agent's most recent response. Your only job is to decide whether the goal is fully satisfied based on that response.

A goal is DONE only when:
- The response explicitly confirms the goal was completed, OR
- The response clearly shows the final deliverable was produced, OR
- The response explains the goal is unachievable / blocked / needs user input (treat this as DONE with reason describing the block).

Otherwise the goal is NOT done — CONTINUE.

Reply ONLY with a single JSON object on one line:
{"done": <true|false>, "reason": "<one-sentence rationale>"}`;

const DEFAULT_JUDGE_MAX_TOKENS = 4096;
const DEFAULT_JUDGE_TIMEOUT_MS = 30000;
const GOAL_MAX_LENGTH = 2000;
const RESPONSE_MAX_LENGTH = 4000;
const SUBGOALS_MAX_LENGTH = 2000;

export interface JudgeServiceInput {
	goal: string;
	response: string;
	subgoals?: string[];
}

export interface JudgeVerdict {
	done: boolean;
	reason: string;
	parseFailed: boolean;
}

export class JudgeService {
	async evaluate(input: JudgeServiceInput, ctx: ExtensionContext): Promise<JudgeVerdict> {
		const model = findJudgeModel(ctx);
		if (!model) {
			return {
				done: false,
				reason: "no judge model available",
				parseFailed: false,
			};
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			return {
				done: false,
				reason: auth.error,
				parseFailed: false,
			};
		}

		try {
			const stream = streamSimple(
				model,
				{
					systemPrompt: JUDGE_SYSTEM_PROMPT,
					messages: [makeJudgeMessage(input)],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					temperature: 0,
					maxTokens: DEFAULT_JUDGE_MAX_TOKENS,
					timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
					signal: ctx.signal,
				},
			);
			const message = await stream.result();
			return parseJudgeResponse(extractTextContent(message));
		} catch (error) {
			return {
				done: false,
				reason: error instanceof Error ? error.message : String(error),
				parseFailed: false,
			};
		}
	}
}

export function buildJudgeUserPrompt(goal: string, response: string): string {
	return `Goal:
${truncate(goal, GOAL_MAX_LENGTH)}

Agent's most recent response:
${truncate(response, RESPONSE_MAX_LENGTH)}

Is the goal satisfied?`;
}

export function buildJudgeUserPromptWithSubgoals(goal: string, response: string, subgoals: string[]): string {
	const subgoalsBlock = truncate(renderSubgoals(subgoals), SUBGOALS_MAX_LENGTH);

	return `Goal:
${truncate(goal, GOAL_MAX_LENGTH)}

Additional criteria the user added mid-loop (all must also be satisfied for the goal to be DONE):
${subgoalsBlock}

Agent's most recent response:
${truncate(response, RESPONSE_MAX_LENGTH)}

Decision: For each numbered criterion above, find concrete evidence in the agent's response that the criterion is satisfied. Do not accept generic phrases like 'all requirements met' or 'implying it was done' — require specific evidence (a file contents excerpt, an output line, a command result). If ANY criterion lacks specific evidence in the response, the goal is NOT done — return CONTINUE.

Is the goal AND every additional criterion satisfied?`;
}

export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) {
		return text;
	}

	if (maxLen <= 3) {
		return ".".repeat(maxLen);
	}

	return `${text.slice(0, maxLen - 3)}...`;
}

export function parseJudgeResponse(raw: string): JudgeVerdict {
	for (const candidate of [raw.trim(), extractMarkdownJson(raw), extractEmbeddedJson(raw)]) {
		if (!candidate) {
			continue;
		}

		const parsed = tryParseJudgeJson(candidate);
		if (parsed) {
			return parsed;
		}
	}

	const snippet = raw.trim().slice(0, RESPONSE_MAX_LENGTH);
	return {
		done: false,
		reason: `judge reply was not JSON: ${snippet || "empty response"}`,
		parseFailed: true,
	};
}

function findJudgeModel(ctx: ExtensionContext): Model<any> | undefined {
	return (
		ctx.modelRegistry.find("anthropic", "claude-haiku-4-5") ??
		ctx.modelRegistry.find("openai", "gpt-4o-mini")
	);
}

function makeJudgeMessage(input: JudgeServiceInput): UserMessage {
	const prompt = input.subgoals?.length
		? buildJudgeUserPromptWithSubgoals(input.goal, input.response, input.subgoals)
		: buildJudgeUserPrompt(input.goal, input.response);

	return {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};
}

function renderSubgoals(subgoals: string[]): string {
	return subgoals.map((subgoal, index) => `- ${index + 1}. ${subgoal}`).join("\n");
}

function extractTextContent(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function extractMarkdownJson(raw: string): string | null {
	const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	return match?.[1]?.trim() || null;
}

function extractEmbeddedJson(raw: string): string | null {
	const match = raw.match(/\{[\s\S]*\}/);
	return match?.[0]?.trim() || null;
}

function tryParseJudgeJson(candidate: string): JudgeVerdict | null {
	try {
		const value = JSON.parse(candidate) as unknown;
		if (!isRecord(value)) {
			return null;
		}

		const done = normalizeDone(value.done);
		if (done === null) {
			return null;
		}

		return {
			done,
			reason: typeof value.reason === "string" && value.reason.length > 0 ? value.reason : "no reason provided",
			parseFailed: false,
		};
	} catch {
		return null;
	}
}

function normalizeDone(value: unknown): boolean | null {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "yes", "1", "done"].includes(normalized)) {
			return true;
		}
		if (["false", "no", "0", "continue"].includes(normalized)) {
			return false;
		}
	}

	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
