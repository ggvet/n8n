/**
 * Tests for content extractor utilities
 */

import type { AIMessage } from '@langchain/core/messages';
import { extractTextContent, extractThinkingContent } from '../content-extractors';

// Helper to create mock AIMessage
function createMockMessage(
	content: string | Array<{ type: string; text?: string; thinking?: string }>,
): AIMessage {
	return {
		content,
		_getType: () => 'ai',
	} as unknown as AIMessage;
}

describe('extractTextContent', () => {
	it('should return string content directly', () => {
		const message = createMockMessage('Hello world');
		expect(extractTextContent(message)).toBe('Hello world');
	});

	it('should return null for empty string content', () => {
		const message = createMockMessage('');
		expect(extractTextContent(message)).toBeNull();
	});

	it('should extract text from array content blocks', () => {
		const message = createMockMessage([
			{ type: 'text', text: 'First part' },
			{ type: 'text', text: 'Second part' },
		]);
		expect(extractTextContent(message)).toBe('First part\nSecond part');
	});

	it('should ignore non-text blocks in array content', () => {
		const message = createMockMessage([
			{ type: 'text', text: 'Text content' },
			{ type: 'tool_use', text: 'should be ignored' },
		]);
		expect(extractTextContent(message)).toBe('Text content');
	});

	it('should return null for array with no text blocks', () => {
		const message = createMockMessage([{ type: 'tool_use' }]);
		expect(extractTextContent(message)).toBeNull();
	});

	it('should return null for empty array', () => {
		const message = createMockMessage([]);
		expect(extractTextContent(message)).toBeNull();
	});
});

describe('extractThinkingContent', () => {
	it('should extract <thinking> tags from text content', () => {
		const message = createMockMessage(
			'Some preamble <thinking>My thinking here</thinking> some more',
		);
		expect(extractThinkingContent(message)).toBe('My thinking here');
	});

	it('should extract multiple <thinking> blocks', () => {
		const message = createMockMessage(
			'<thinking>First thought</thinking> middle <thinking>Second thought</thinking>',
		);
		expect(extractThinkingContent(message)).toBe('First thought\n\nSecond thought');
	});

	it('should return null when no thinking tags present', () => {
		const message = createMockMessage('Just regular content');
		expect(extractThinkingContent(message)).toBeNull();
	});

	it('should extract from thinking content blocks in array', () => {
		const message = createMockMessage([
			{ type: 'text', text: 'Some text' },
			{ type: 'thinking', thinking: 'Extended thinking content' },
		]);
		expect(extractThinkingContent(message)).toBe('Extended thinking content');
	});

	it('should return null for empty content', () => {
		const message = createMockMessage('');
		expect(extractThinkingContent(message)).toBeNull();
	});
});
