export type PlannerQuestionType = 'single' | 'multi' | 'text';

export interface PlannerQuestion {
	id: string;
	question: string;
	type: PlannerQuestionType;
	options?: string[];
	/**
	 * Defaults to true when omitted.
	 * Frontend may still render a free-form input even when options exist.
	 */
	allowCustom?: boolean;
}

export interface QuestionResponse {
	questionId: string;
	question: string;
	selectedOptions: string[];
	customText?: string;
	skipped?: boolean;
}

export interface PlanStep {
	description: string;
	subSteps?: string[];
	/**
	 * Suggested internal node type names (e.g. "n8n-nodes-base.gmail").
	 */
	suggestedNodes?: string[];
}

export interface PlanOutput {
	summary: string;
	trigger: string;
	steps: PlanStep[];
	additionalSpecs?: string[];
}

export interface QuestionsInterruptValue {
	type: 'questions';
	introMessage?: string;
	questions: PlannerQuestion[];
}

export interface PlanInterruptValue {
	type: 'plan';
	plan: PlanOutput;
}

export type HITLInterruptValue = QuestionsInterruptValue | PlanInterruptValue;

export type PlanDecision = 'approve' | 'reject' | 'modify';
