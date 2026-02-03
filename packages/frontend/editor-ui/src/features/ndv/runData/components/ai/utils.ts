import type { IAiDataContent } from '@/Interface';
import type {
	INodeExecutionData,
	ITaskData,
	ITaskDataConnections,
	NodeConnectionType,
} from 'n8n-workflow';
import { splitTextBySearch } from '@/app/utils/stringUtils';
import { escapeHtml } from 'xss';
import type MarkdownIt from 'markdown-it';
import { unescapeAll } from 'markdown-it/lib/common/utils';

/**
 * Filters node execution data to only include keys that are in the toolInputKeys list.
 * This is used to filter out agent input data from AI tool execution logs,
 * showing only the tool arguments that were passed by the AI model.
 */
function filterByToolInputKeys(
	data: INodeExecutionData[] | null,
	toolInputKeys: string[],
): INodeExecutionData[] | null {
	if (!data) return null;

	return data.map((item) => ({
		...item,
		json: Object.fromEntries(
			Object.entries(item.json).filter(([key]) => toolInputKeys.includes(key)),
		),
	}));
}

export function getReferencedData(taskData: ITaskData): IAiDataContent[] {
	const returnData: IAiDataContent[] = [];
	const toolInputKeys = taskData.metadata?.toolInputKeys;

	function addFunction(data: ITaskDataConnections | undefined, inOut: 'input' | 'output') {
		if (!data) {
			return;
		}

		Object.keys(data).map((type) => {
			let processedData = data[type][0];

			// Filter input data to only show tool arguments (not agent input)
			if (inOut === 'input' && toolInputKeys && processedData) {
				processedData = filterByToolInputKeys(processedData, toolInputKeys);
			}

			returnData.push({
				data: processedData,
				inOut,
				type: type as NodeConnectionType,
				// Include source information in AI content to track which node triggered the execution
				// This enables filtering in the UI to show only relevant executions
				source: taskData.source,
				metadata: {
					executionTime: taskData.executionTime,
					startTime: taskData.startTime,
					subExecution: taskData.metadata?.subExecution,
				},
			});
		});
	}

	addFunction(taskData.inputOverride, 'input');
	addFunction(taskData.data, 'output');

	return returnData;
}

export function createHtmlFragmentWithSearchHighlight(
	text: string,
	search: string | undefined,
): string {
	const escaped = escapeHtml(text);

	return search
		? splitTextBySearch(escaped, search)
				.map((part) => (part.isMatched ? `<mark>${part.content}</mark>` : part.content))
				.join('')
		: escaped;
}

export function createSearchHighlightPlugin(search: string | undefined) {
	return (md: MarkdownIt) => {
		md.renderer.rules.text = (tokens, idx) =>
			createHtmlFragmentWithSearchHighlight(tokens[idx].content, search);

		md.renderer.rules.code_inline = (tokens, idx, _, __, slf) =>
			`<code${slf.renderAttrs(tokens[idx])}>${createHtmlFragmentWithSearchHighlight(tokens[idx].content, search)}</code>`;

		md.renderer.rules.code_block = (tokens, idx, _, __, slf) =>
			`<pre${slf.renderAttrs(tokens[idx])}><code>${createHtmlFragmentWithSearchHighlight(tokens[idx].content, search)}</code></pre>\n`;

		md.renderer.rules.fence = (tokens, idx, options, _, slf) => {
			const token = tokens[idx];
			const info = token.info ? unescapeAll(token.info).trim() : '';
			let langName = '';
			let langAttrs = '';

			if (info) {
				const arr = info.split(/(\s+)/g);
				langName = arr[0];
				langAttrs = arr.slice(2).join('');
			}

			const highlighted =
				options.highlight?.(token.content, langName, langAttrs) ??
				createHtmlFragmentWithSearchHighlight(token.content, search);

			if (highlighted.indexOf('<pre') === 0) {
				return highlighted + '\n';
			}

			return `<pre><code${slf.renderAttrs(token)}>${highlighted}</code></pre>\n`;
		};
	};
}
