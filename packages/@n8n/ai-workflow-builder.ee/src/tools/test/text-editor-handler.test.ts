import { TextEditorHandler } from '../text-editor-handler';
import {
	NoMatchFoundError,
	MultipleMatchesError,
	InvalidLineNumberError,
	InvalidPathError,
	FileExistsError,
	FileNotFoundError,
} from '../../types/text-editor';

describe('TextEditorHandler', () => {
	let handler: TextEditorHandler;

	beforeEach(() => {
		handler = new TextEditorHandler();
	});

	describe('view command', () => {
		it('should return file content with line numbers', () => {
			const code = 'line1\nline2\nline3';
			handler.setWorkflowCode(code);

			const result = handler.execute({
				command: 'view',
				path: '/workflow.ts',
			});

			expect(result).toBe('1: line1\n2: line2\n3: line3');
		});

		it('should return view_range subset with line numbers', () => {
			const code = 'line1\nline2\nline3\nline4\nline5';
			handler.setWorkflowCode(code);

			const result = handler.execute({
				command: 'view',
				path: '/workflow.ts',
				view_range: [2, 4],
			});

			expect(result).toBe('2: line2\n3: line3\n4: line4');
		});

		it('should clamp view_range end to file length', () => {
			const code = 'line1\nline2\nline3';
			handler.setWorkflowCode(code);

			const result = handler.execute({
				command: 'view',
				path: '/workflow.ts',
				view_range: [2, 100],
			});

			expect(result).toBe('2: line2\n3: line3');
		});

		it('should throw FileNotFoundError when no code exists', () => {
			expect(() =>
				handler.execute({
					command: 'view',
					path: '/workflow.ts',
				}),
			).toThrow(FileNotFoundError);
		});

		it('should throw InvalidLineNumberError for invalid start line', () => {
			handler.setWorkflowCode('line1\nline2');

			expect(() =>
				handler.execute({
					command: 'view',
					path: '/workflow.ts',
					view_range: [0, 2],
				}),
			).toThrow(InvalidLineNumberError);
		});

		it('should throw InvalidLineNumberError when start exceeds file length', () => {
			handler.setWorkflowCode('line1\nline2');

			expect(() =>
				handler.execute({
					command: 'view',
					path: '/workflow.ts',
					view_range: [5, 10],
				}),
			).toThrow(InvalidLineNumberError);
		});
	});

	describe('create command', () => {
		it('should throw error when create is called (create is not supported)', () => {
			expect(() =>
				handler.execute({
					command: 'create',
					path: '/workflow.ts',
					file_text: 'const x = 1;',
				}),
			).toThrow('The "create" command is not supported');
		});

		it('should throw error even when file already exists', () => {
			handler.setWorkflowCode('existing content');

			expect(() =>
				handler.execute({
					command: 'create',
					path: '/workflow.ts',
					file_text: 'new content',
				}),
			).toThrow('The "create" command is not supported');
		});
	});

	describe('str_replace command', () => {
		it('should replace exact single match', () => {
			handler.setWorkflowCode('const x = 1;\nconst y = 2;');

			const result = handler.execute({
				command: 'str_replace',
				path: '/workflow.ts',
				old_str: 'const y = 2;',
				new_str: 'const y = 3;',
			});

			expect(result).toBe('Edit applied successfully.');
			expect(handler.getWorkflowCode()).toBe('const x = 1;\nconst y = 3;');
		});

		it('should throw NoMatchFoundError when no match found', () => {
			handler.setWorkflowCode('const x = 1;');

			expect(() =>
				handler.execute({
					command: 'str_replace',
					path: '/workflow.ts',
					old_str: 'const y = 2;',
					new_str: 'const y = 3;',
				}),
			).toThrow(NoMatchFoundError);
		});

		it('should throw MultipleMatchesError when multiple matches found', () => {
			handler.setWorkflowCode('const x = 1;\nconst x = 1;');

			expect(() =>
				handler.execute({
					command: 'str_replace',
					path: '/workflow.ts',
					old_str: 'const x = 1;',
					new_str: 'const x = 2;',
				}),
			).toThrow(MultipleMatchesError);
		});

		it('should throw FileNotFoundError when no code exists', () => {
			expect(() =>
				handler.execute({
					command: 'str_replace',
					path: '/workflow.ts',
					old_str: 'old',
					new_str: 'new',
				}),
			).toThrow(FileNotFoundError);
		});

		it('should handle multiline replacements', () => {
			handler.setWorkflowCode('function foo() {\n  return 1;\n}');

			handler.execute({
				command: 'str_replace',
				path: '/workflow.ts',
				old_str: 'function foo() {\n  return 1;\n}',
				new_str: 'function foo() {\n  return 2;\n}',
			});

			expect(handler.getWorkflowCode()).toBe('function foo() {\n  return 2;\n}');
		});
	});

	describe('insert command', () => {
		it('should insert at beginning of file (line 0)', () => {
			handler.setWorkflowCode('line1\nline2');

			const result = handler.execute({
				command: 'insert',
				path: '/workflow.ts',
				insert_line: 0,
				new_str: 'line0',
			});

			expect(result).toBe('Text inserted successfully.');
			expect(handler.getWorkflowCode()).toBe('line0\nline1\nline2');
		});

		it('should insert after specified line', () => {
			handler.setWorkflowCode('line1\nline3');

			handler.execute({
				command: 'insert',
				path: '/workflow.ts',
				insert_line: 1,
				new_str: 'line2',
			});

			expect(handler.getWorkflowCode()).toBe('line1\nline2\nline3');
		});

		it('should insert at end of file', () => {
			handler.setWorkflowCode('line1\nline2');

			handler.execute({
				command: 'insert',
				path: '/workflow.ts',
				insert_line: 2,
				new_str: 'line3',
			});

			expect(handler.getWorkflowCode()).toBe('line1\nline2\nline3');
		});

		it('should throw InvalidLineNumberError for negative line', () => {
			handler.setWorkflowCode('line1');

			expect(() =>
				handler.execute({
					command: 'insert',
					path: '/workflow.ts',
					insert_line: -1,
					new_str: 'new',
				}),
			).toThrow(InvalidLineNumberError);
		});

		it('should throw InvalidLineNumberError when line exceeds file length', () => {
			handler.setWorkflowCode('line1\nline2');

			expect(() =>
				handler.execute({
					command: 'insert',
					path: '/workflow.ts',
					insert_line: 5,
					new_str: 'new',
				}),
			).toThrow(InvalidLineNumberError);
		});

		it('should throw FileNotFoundError when no code exists', () => {
			expect(() =>
				handler.execute({
					command: 'insert',
					path: '/workflow.ts',
					insert_line: 0,
					new_str: 'new',
				}),
			).toThrow(FileNotFoundError);
		});
	});

	describe('validate command', () => {
		it('should return message indicating agent should handle it', () => {
			handler.setWorkflowCode('code');

			const result = handler.execute({
				command: 'validate',
				path: '/workflow.ts',
			});

			expect(result).toBe('Validate command should be handled by the agent.');
		});
	});

	describe('path validation', () => {
		it('should throw InvalidPathError for unsupported paths', () => {
			expect(() =>
				handler.execute({
					command: 'view',
					path: '/other.ts',
				}),
			).toThrow(InvalidPathError);

			expect(() =>
				handler.execute({
					command: 'create',
					path: '/src/workflow.ts',
					file_text: 'code',
				}),
			).toThrow(InvalidPathError);
		});
	});

	describe('accessor methods', () => {
		it('getWorkflowCode should return null initially', () => {
			expect(handler.getWorkflowCode()).toBeNull();
		});

		it('setWorkflowCode should set the code', () => {
			handler.setWorkflowCode('test code');
			expect(handler.getWorkflowCode()).toBe('test code');
		});

		it('hasWorkflowCode should return false initially', () => {
			expect(handler.hasWorkflowCode()).toBe(false);
		});

		it('hasWorkflowCode should return true after setting code', () => {
			handler.setWorkflowCode('code');
			expect(handler.hasWorkflowCode()).toBe(true);
		});

		it('clearWorkflowCode should clear the code', () => {
			handler.setWorkflowCode('code');
			handler.clearWorkflowCode();
			expect(handler.getWorkflowCode()).toBeNull();
			expect(handler.hasWorkflowCode()).toBe(false);
		});
	});

	describe('error messages', () => {
		it('NoMatchFoundError should have descriptive message', () => {
			const error = new NoMatchFoundError('search string');
			expect(error.message).toContain('No match found');
			expect(error.name).toBe('NoMatchFoundError');
		});

		it('MultipleMatchesError should include count', () => {
			const error = new MultipleMatchesError(3);
			expect(error.message).toContain('Found 3 matches');
			expect(error.name).toBe('MultipleMatchesError');
		});

		it('InvalidLineNumberError should include line info', () => {
			const error = new InvalidLineNumberError(10, 5);
			expect(error.message).toContain('Invalid line number 10');
			expect(error.message).toContain('5 lines');
			expect(error.name).toBe('InvalidLineNumberError');
		});

		it('InvalidPathError should include path', () => {
			const error = new InvalidPathError('/bad/path.ts');
			expect(error.message).toContain('/bad/path.ts');
			expect(error.message).toContain('/workflow.ts');
			expect(error.name).toBe('InvalidPathError');
		});

		it('FileExistsError should have descriptive message', () => {
			const error = new FileExistsError();
			expect(error.message).toContain('already exists');
			expect(error.name).toBe('FileExistsError');
		});

		it('FileNotFoundError should have descriptive message', () => {
			const error = new FileNotFoundError();
			expect(error.message).toContain('No workflow code exists');
			expect(error.name).toBe('FileNotFoundError');
		});
	});
});
