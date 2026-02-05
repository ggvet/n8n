/**
 * Tests for ParseValidateHandler
 */

import { parseWorkflowCodeToBuilder, validateWorkflow } from '@n8n/workflow-sdk';

import type { ParseAndValidateResult } from '../../types';
import { ParseValidateHandler } from '../parse-validate-handler';

// Mock the workflow-sdk module
jest.mock('@n8n/workflow-sdk', () => ({
	parseWorkflowCodeToBuilder: jest.fn(),
	validateWorkflow: jest.fn(),
	stripImportStatements: jest.fn((code: string) => code),
}));

// Typed mock references
const mockParseWorkflowCodeToBuilder = parseWorkflowCodeToBuilder as jest.Mock;
const mockValidateWorkflow = validateWorkflow as jest.Mock;

describe('ParseValidateHandler', () => {
	let handler: ParseValidateHandler;
	let mockDebugLog: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();

		mockDebugLog = jest.fn();

		handler = new ParseValidateHandler({
			debugLog: mockDebugLog,
		});
	});

	describe('parseAndValidate', () => {
		it('should parse valid code and return workflow', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [{ id: 'node1', name: 'Node 1', type: 'test' }],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({ valid: true, errors: [], warnings: [] });

			const result = await handler.parseAndValidate('const workflow = {}');

			expect(result.workflow).toEqual(mockWorkflow);
			expect(result.warnings).toHaveLength(0);
			expect(mockBuilder.regenerateNodeIds).toHaveBeenCalled();
			expect(mockBuilder.validate).toHaveBeenCalled();
		});

		it('should collect errors from graph validation as warnings for agent self-correction', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({
					valid: false,
					errors: [{ code: 'ERR001', message: 'Graph error', nodeName: 'TestNode' }],
					warnings: [],
				}),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({ valid: true, errors: [], warnings: [] });

			const result = await handler.parseAndValidate('code');

			// Graph validation errors should be included as warnings for agent self-correction
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0].code).toBe('ERR001');
			expect(result.warnings[0].message).toBe('Graph error');
			expect(result.warnings[0].nodeName).toBe('TestNode');
		});

		it('should collect warnings from graph validation', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({
					valid: true,
					errors: [],
					warnings: [{ code: 'WARN001', message: 'Graph warning', nodeName: 'Node1' }],
				}),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({ valid: true, errors: [], warnings: [] });

			const result = await handler.parseAndValidate('code');

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0].code).toBe('WARN001');
		});

		it('should collect warnings from JSON validation', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({
				valid: true,
				errors: [],
				warnings: [{ code: 'JSON_WARN', message: 'JSON warning' }],
			});

			const result = await handler.parseAndValidate('code');

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0].code).toBe('JSON_WARN');
		});

		it('should collect errors from JSON validation as warnings for agent self-correction', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({
				valid: false,
				errors: [{ code: 'JSON_ERR', message: 'JSON validation error', nodeName: 'TestNode' }],
				warnings: [],
			});

			const result = await handler.parseAndValidate('code');

			// JSON validation errors should be included as warnings for agent self-correction
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0].code).toBe('JSON_ERR');
			expect(result.warnings[0].message).toBe('JSON validation error');
			expect(result.warnings[0].nodeName).toBe('TestNode');
		});

		it('should collect both errors and warnings from JSON validation', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({
				valid: false,
				errors: [{ code: 'JSON_ERR', message: 'JSON error' }],
				warnings: [{ code: 'JSON_WARN', message: 'JSON warning' }],
			});

			const result = await handler.parseAndValidate('code');

			// Both errors and warnings should be collected for agent self-correction
			expect(result.warnings).toHaveLength(2);
			expect(result.warnings.map((w) => w.code)).toContain('JSON_ERR');
			expect(result.warnings.map((w) => w.code)).toContain('JSON_WARN');
		});

		it('should pass currentWorkflow to generatePinData', async () => {
			const currentWorkflow = { id: 'current', name: 'Current', nodes: [], connections: {} };
			const mockWorkflow = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			const mockBuilder = {
				regenerateNodeIds: jest.fn(),
				validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
				generatePinData: jest.fn(),
				toJSON: jest.fn().mockReturnValue(mockWorkflow),
			};

			mockParseWorkflowCodeToBuilder.mockReturnValue(mockBuilder);
			mockValidateWorkflow.mockReturnValue({ valid: true, errors: [], warnings: [] });

			await handler.parseAndValidate('code', currentWorkflow);

			expect(mockBuilder.generatePinData).toHaveBeenCalledWith({ beforeWorkflow: currentWorkflow });
		});

		it('should throw on parse error', async () => {
			mockParseWorkflowCodeToBuilder.mockImplementation(() => {
				throw new Error('Syntax error at line 5');
			});

			await expect(handler.parseAndValidate('invalid syntax')).rejects.toThrow(
				'Failed to parse generated workflow code',
			);
		});
	});

	describe('formatValidationFeedback', () => {
		it('should format warnings with error context', () => {
			const result: ParseAndValidateResult = {
				workflow: { id: 'test', name: 'Test', nodes: [], connections: {} },
				warnings: [{ code: 'WARN001', message: 'Missing parameter at line 10' }],
			};

			const code =
				'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12';

			const feedback = handler.formatValidationFeedback(result, code);

			expect(feedback.feedbackMessage).toContain('WARN001');
			expect(feedback.feedbackMessage).toContain('Missing parameter');
		});

		it('should return empty feedback when no warnings', () => {
			const result: ParseAndValidateResult = {
				workflow: { id: 'test', name: 'Test', nodes: [], connections: {} },
				warnings: [],
			};

			const feedback = handler.formatValidationFeedback(result, 'code');

			expect(feedback.feedbackMessage).toBe('');
			expect(feedback.hasWarnings).toBe(false);
		});
	});

	describe('formatParseError', () => {
		it('should format parse error with code context', () => {
			const code = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';

			const feedback = handler.formatParseError(new Error('Unexpected token at line 5'), code);

			expect(feedback.feedbackMessage).toContain('Parse error');
			expect(feedback.feedbackMessage).toContain('Unexpected token');
		});

		it('should show first lines when no line number in error', () => {
			const code = 'line1\nline2\nline3\nline4\nline5';

			const feedback = handler.formatParseError(new Error('Some generic error'), code);

			expect(feedback.feedbackMessage).toContain('Parse error');
			expect(feedback.feedbackMessage).toContain('Some generic error');
		});
	});

	describe('getErrorContext', () => {
		it('should extract context around error line', () => {
			const code = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';

			const context = handler.getErrorContext(code, 'error at line 5');

			expect(context).toContain('5:');
			expect(context).toContain('line5');
		});

		it('should show first lines when no line number found', () => {
			const code = 'line1\nline2\nline3\nline4\nline5';

			const context = handler.getErrorContext(code, 'generic error');

			expect(context).toContain('1:');
			expect(context).toContain('line1');
		});
	});
});
