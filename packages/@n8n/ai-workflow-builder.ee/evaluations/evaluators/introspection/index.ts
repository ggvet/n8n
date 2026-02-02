import type { IntrospectionEvent } from '@/tools/introspect.tool';
import type { SimpleWorkflow } from '@/types/workflow';

import type { EvaluationContext, Evaluator, Feedback } from '../../harness/harness-types';

// Re-export the type for convenience
export type { IntrospectionEvent };

/**
 * Evaluator that collects introspection events via a callback function.
 * Events are extracted from AIMessage tool_calls in the agent state.
 *
 * @param getEvents - Callback function that returns introspection events for the current run.
 *                    This should be a closure that captures events from the agent state.
 */
export function createIntrospectionEvaluator(
	getEvents: () => IntrospectionEvent[] = () => [],
): Evaluator<EvaluationContext> {
	return {
		name: 'introspection',
		async evaluate(_workflow: SimpleWorkflow, _ctx: EvaluationContext): Promise<Feedback[]> {
			// Get events from the callback (populated by the generator)
			const events = getEvents();

			if (events.length === 0) {
				return [
					{
						evaluator: 'introspection',
						metric: 'event_count',
						score: 0,
						kind: 'metric',
						comment: 'No introspection events',
					},
				];
			}

			// Summary feedback
			const feedback: Feedback[] = [
				{
					evaluator: 'introspection',
					metric: 'event_count',
					score: events.length,
					kind: 'metric',
					comment: `${events.length} introspection event(s)`,
				},
			];

			// Individual events as details
			for (const event of events) {
				feedback.push({
					evaluator: 'introspection',
					metric: event.category,
					score: 1,
					kind: 'detail',
					comment: event.issue,
					details: {
						category: event.category,
						source: event.source,
						timestamp: event.timestamp,
					},
				});
			}

			return feedback;
		},
	};
}
