import Markdown from 'markdown-it';
import markdownLink from 'markdown-it-link-attributes';

import { useI18n } from '../../../composables/useI18n';

export function useMarkdown() {
	const { t } = useI18n();

	const md = new Markdown({
		breaks: true,
	});

	md.use(markdownLink, {
		attrs: {
			target: '_blank',
			rel: 'noopener',
		},
	});

	/**
	 * Process <n8n_thinking> tags into collapsible sections.
	 * - Complete tags: transform to <details> elements
	 * - Incomplete tags (streaming): hide the tag and content after it
	 */
	function processThinkingTags(content: string): string {
		// First, transform complete <n8n_thinking>...</n8n_thinking> pairs into collapsible details
		let processed = content.replace(
			/<n8n_thinking>([\s\S]*?)<\/n8n_thinking>/gi,
			(_, innerContent: string) => {
				return `<details class="n8n-thinking-section"><summary>Thinking...</summary>\n\n${innerContent.trim()}\n\n</details>`;
			},
		);

		// Then, hide any incomplete opening tag (streaming case)
		// If there's an <n8n_thinking> without a closing tag, remove it and everything after
		const incompleteTagIndex = processed.indexOf('<n8n_thinking>');
		if (incompleteTagIndex !== -1) {
			processed = processed.substring(0, incompleteTagIndex);
		}

		return processed;
	}

	function renderMarkdown(content: string) {
		try {
			const processedContent = processThinkingTags(content);
			return md.render(processedContent);
		} catch (e) {
			console.error(`Error parsing markdown content ${content}`);
			return `<p>${t('assistantChat.errorParsingMarkdown')}</p>`;
		}
	}

	return {
		renderMarkdown,
	};
}
