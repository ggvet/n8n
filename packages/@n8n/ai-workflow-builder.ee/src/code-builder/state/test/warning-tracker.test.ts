/**
 * Tests for WarningTracker class
 */

import { WarningTracker } from '../warning-tracker';
import type { ValidationWarning } from '../../types';

describe('WarningTracker', () => {
	let tracker: WarningTracker;

	beforeEach(() => {
		tracker = new WarningTracker();
	});

	describe('filterNewWarnings', () => {
		it('should return all warnings when none have been seen', () => {
			const warnings: ValidationWarning[] = [
				{ code: 'WARN001', message: 'Warning 1' },
				{ code: 'WARN002', message: 'Warning 2' },
			];

			const result = tracker.filterNewWarnings(warnings);
			expect(result).toEqual(warnings);
		});

		it('should filter out previously seen warnings', () => {
			const warning1: ValidationWarning = { code: 'WARN001', message: 'Warning 1' };
			const warning2: ValidationWarning = { code: 'WARN002', message: 'Warning 2' };

			tracker.markAsSeen([warning1]);

			const result = tracker.filterNewWarnings([warning1, warning2]);
			expect(result).toEqual([warning2]);
		});

		it('should use code|nodeName|parameterPath as deduplication key', () => {
			const warning1: ValidationWarning = {
				code: 'WARN001',
				message: 'Old message',
				nodeName: 'Node1',
				parameterPath: 'path.to.param',
			};

			const warning2: ValidationWarning = {
				code: 'WARN001',
				message: 'New message', // Different message but same key
				nodeName: 'Node1',
				parameterPath: 'path.to.param',
			};

			tracker.markAsSeen([warning1]);

			const result = tracker.filterNewWarnings([warning2]);
			expect(result).toHaveLength(0);
		});

		it('should treat warnings with same code but different node as different', () => {
			const warning1: ValidationWarning = {
				code: 'WARN001',
				message: 'Warning',
				nodeName: 'Node1',
			};

			const warning2: ValidationWarning = {
				code: 'WARN001',
				message: 'Warning',
				nodeName: 'Node2',
			};

			tracker.markAsSeen([warning1]);

			const result = tracker.filterNewWarnings([warning2]);
			expect(result).toEqual([warning2]);
		});

		it('should handle warnings without optional fields', () => {
			const warning1: ValidationWarning = { code: 'WARN001', message: 'Warning 1' };
			const warning2: ValidationWarning = { code: 'WARN001', message: 'Warning 2' };

			// Same code, no nodeName or parameterPath - should be same key
			tracker.markAsSeen([warning1]);

			const result = tracker.filterNewWarnings([warning2]);
			expect(result).toHaveLength(0);
		});

		it('should return empty array when all warnings are seen', () => {
			const warnings: ValidationWarning[] = [
				{ code: 'WARN001', message: 'Warning 1' },
				{ code: 'WARN002', message: 'Warning 2' },
			];

			tracker.markAsSeen(warnings);

			const result = tracker.filterNewWarnings(warnings);
			expect(result).toHaveLength(0);
		});
	});

	describe('markAsSeen', () => {
		it('should add warnings to seen set', () => {
			const warning: ValidationWarning = { code: 'WARN001', message: 'Warning' };

			tracker.markAsSeen([warning]);

			const result = tracker.filterNewWarnings([warning]);
			expect(result).toHaveLength(0);
		});

		it('should handle empty array', () => {
			tracker.markAsSeen([]);

			const warning: ValidationWarning = { code: 'WARN001', message: 'Warning' };
			const result = tracker.filterNewWarnings([warning]);
			expect(result).toHaveLength(1);
		});
	});

	describe('allSeen', () => {
		it('should return true when all warnings have been seen', () => {
			const warnings: ValidationWarning[] = [
				{ code: 'WARN001', message: 'Warning 1' },
				{ code: 'WARN002', message: 'Warning 2' },
			];

			tracker.markAsSeen(warnings);

			expect(tracker.allSeen(warnings)).toBe(true);
		});

		it('should return false when some warnings are new', () => {
			const warning1: ValidationWarning = { code: 'WARN001', message: 'Warning 1' };
			const warning2: ValidationWarning = { code: 'WARN002', message: 'Warning 2' };

			tracker.markAsSeen([warning1]);

			expect(tracker.allSeen([warning1, warning2])).toBe(false);
		});

		it('should return true for empty array', () => {
			expect(tracker.allSeen([])).toBe(true);
		});

		it('should return false when no warnings have been seen', () => {
			const warnings: ValidationWarning[] = [{ code: 'WARN001', message: 'Warning' }];

			expect(tracker.allSeen(warnings)).toBe(false);
		});
	});

	describe('getWarningKey', () => {
		it('should create correct key with all fields', () => {
			const warning: ValidationWarning = {
				code: 'WARN001',
				message: 'Warning',
				nodeName: 'HTTP Request',
				parameterPath: 'authentication.type',
			};

			// Mark and verify deduplication works correctly
			tracker.markAsSeen([warning]);

			const sameKeyWarning: ValidationWarning = {
				code: 'WARN001',
				message: 'Different message',
				nodeName: 'HTTP Request',
				parameterPath: 'authentication.type',
			};

			expect(tracker.allSeen([sameKeyWarning])).toBe(true);
		});
	});
});
