import type { WorkflowRepository } from '@n8n/db';
import type { ActiveWorkflows } from 'n8n-core';
import type { INode, IPinData, IWorkflowBase, Workflow } from 'n8n-workflow';
import { mock } from 'jest-mock-extended';

import { SingleTriggerError } from '@/errors/single-trigger.error';
import { TriggerParameterConflictError } from '@/errors/trigger-parameter-conflict.error';
import { TriggerValidationService } from '@/workflows/trigger-validation.service';

describe('TriggerValidationService', () => {
	let service: TriggerValidationService;
	let mockWorkflowRepository: ReturnType<typeof mock<WorkflowRepository>>;
	let mockActiveWorkflows: ReturnType<typeof mock<ActiveWorkflows>>;

	beforeEach(() => {
		mockWorkflowRepository = mock<WorkflowRepository>();
		mockActiveWorkflows = mock<ActiveWorkflows>();
		service = new TriggerValidationService(mockWorkflowRepository, mockActiveWorkflows);
	});

	const createKafkaTriggerNode = (
		name: string,
		groupId: string,
		topic: string,
		options?: { disabled?: boolean },
	): INode => ({
		name,
		type: 'n8n-nodes-base.kafkaTrigger',
		id: `node-${name}`,
		typeVersion: 1,
		position: [0, 0],
		disabled: options?.disabled,
		parameters: { groupId, topic },
	});

	const createRegularNode = (name: string): INode => ({
		name,
		type: 'n8n-nodes-base.set',
		id: `node-${name}`,
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	});

	const createWorkflowData = (
		id: string,
		nodes: INode[],
		options?: { pinData?: IPinData },
	): IWorkflowBase =>
		({
			id,
			name: `Workflow ${id}`,
			nodes,
			connections: {},
			active: false,
			pinData: options?.pinData,
		}) as IWorkflowBase;

	describe('validateManualExecution', () => {
		describe('checkTestRunAllowed', () => {
			it('should allow test run when workflow is not active', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([]);

				await expect(service.validateManualExecution(workflowData, false)).resolves.not.toThrow();
			});

			it('should throw SingleTriggerError when workflow is active with Kafka trigger', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
				]);

				await expect(service.validateManualExecution(workflowData, true)).rejects.toThrow(
					SingleTriggerError,
				);
			});

			it('should allow test run when Kafka trigger is disabled', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1', { disabled: true }),
				]);

				mockWorkflowRepository.find.mockResolvedValue([]);

				await expect(service.validateManualExecution(workflowData, true)).resolves.not.toThrow();
			});

			it('should allow test run when Kafka trigger has pinned data', async () => {
				const workflowData = createWorkflowData(
					'workflow-1',
					[createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1')],
					{ pinData: { 'Kafka Trigger': [{ json: { data: 'pinned' } }] } },
				);

				mockWorkflowRepository.find.mockResolvedValue([]);

				await expect(service.validateManualExecution(workflowData, true)).resolves.not.toThrow();
			});

			it('should throw SingleTriggerError for specific trigger when triggerToStartFrom is provided', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger 1', 'group-1', 'topic-1'),
					createKafkaTriggerNode('Kafka Trigger 2', 'group-2', 'topic-2'),
				]);

				await expect(
					service.validateManualExecution(workflowData, true, { name: 'Kafka Trigger 2' }),
				).rejects.toThrow(SingleTriggerError);
			});

			it('should allow test run when triggerToStartFrom is not a restricted trigger', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
					createRegularNode('Set Node'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([]);

				await expect(
					service.validateManualExecution(workflowData, true, { name: 'Set Node' }),
				).resolves.not.toThrow();
			});
		});

		describe('checkConflicts', () => {
			it('should not check conflicts when no triggers with unique parameters exist', async () => {
				const workflowData = createWorkflowData('workflow-1', [createRegularNode('Set Node')]);

				await service.validateManualExecution(workflowData, false);

				expect(mockWorkflowRepository.find).not.toHaveBeenCalled();
			});

			it('should throw TriggerParameterConflictError when groupId and topic both conflict with active workflow', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'shared-topic'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-2',
						name: 'Active Workflow',
						active: true,
						activeVersion: {
							nodes: [createKafkaTriggerNode('Other Kafka', 'shared-group', 'shared-topic')],
						},
					} as any,
				]);

				await expect(service.validateManualExecution(workflowData, false)).rejects.toThrow(
					TriggerParameterConflictError,
				);
			});

			it('should not throw when only groupId matches but topic is different', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'topic-1'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-2',
						name: 'Active Workflow',
						active: true,
						activeVersion: {
							nodes: [createKafkaTriggerNode('Other Kafka', 'shared-group', 'topic-2')],
						},
					} as any,
				]);

				await expect(service.validateManualExecution(workflowData, false)).resolves.not.toThrow();
			});

			it('should not throw when only topic matches but groupId is different', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'shared-topic'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-2',
						name: 'Active Workflow',
						active: true,
						activeVersion: {
							nodes: [createKafkaTriggerNode('Other Kafka', 'group-2', 'shared-topic')],
						},
					} as any,
				]);

				await expect(service.validateManualExecution(workflowData, false)).resolves.not.toThrow();
			});

			it('should not throw when both groupId and topic are different from active workflows', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-2',
						name: 'Active Workflow',
						active: true,
						activeVersion: {
							nodes: [createKafkaTriggerNode('Other Kafka', 'group-2', 'topic-2')],
						},
					} as any,
				]);

				await expect(service.validateManualExecution(workflowData, false)).resolves.not.toThrow();
			});

			it('should skip checking against the same workflow', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-1',
						name: 'Same Workflow',
						active: true,
						activeVersion: {
							nodes: [createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1')],
						},
					} as any,
				]);

				await expect(service.validateManualExecution(workflowData, false)).resolves.not.toThrow();
			});

			it('should skip disabled nodes in active workflows', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'shared-topic'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-2',
						name: 'Active Workflow',
						active: true,
						activeVersion: {
							nodes: [
								createKafkaTriggerNode('Other Kafka', 'shared-group', 'shared-topic', {
									disabled: true,
								}),
							],
						},
					} as any,
				]);

				await expect(service.validateManualExecution(workflowData, false)).resolves.not.toThrow();
			});

			it('should only check specified trigger when triggerToStartFrom is provided', async () => {
				const workflowData = createWorkflowData('workflow-1', [
					createKafkaTriggerNode('Kafka Trigger 1', 'group-1', 'topic-1'),
					createKafkaTriggerNode('Kafka Trigger 2', 'conflicting-group', 'conflicting-topic'),
				]);

				mockWorkflowRepository.find.mockResolvedValue([
					{
						id: 'workflow-2',
						name: 'Active Workflow',
						active: true,
						activeVersion: {
							nodes: [
								createKafkaTriggerNode('Other Kafka', 'conflicting-group', 'conflicting-topic'),
							],
						},
					} as any,
				]);

				// Should not throw because we're only checking Kafka Trigger 1
				await expect(
					service.validateManualExecution(workflowData, false, { name: 'Kafka Trigger 1' }),
				).resolves.not.toThrow();
			});
		});
	});

	describe('validateWorkflowActivation', () => {
		const createWorkflow = (id: string, nodes: Record<string, INode>): Workflow =>
			({
				id,
				nodes,
			}) as unknown as Workflow;

		it('should not check conflicts when no triggers with unique parameters exist', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Set Node': createRegularNode('Set Node'),
			});

			await service.validateWorkflowActivation(workflow);

			expect(mockActiveWorkflows.allActiveWorkflows).not.toHaveBeenCalled();
		});

		it('should not check conflicts when no other active workflows exist', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue(['workflow-1']);

			await service.validateWorkflowActivation(workflow);

			expect(mockWorkflowRepository.find).not.toHaveBeenCalled();
		});

		it('should throw TriggerParameterConflictError when groupId and topic both conflict with active workflow', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'shared-topic'),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue(['workflow-1', 'workflow-2']);
			mockWorkflowRepository.find.mockResolvedValue([
				{
					id: 'workflow-2',
					name: 'Active Workflow',
					activeVersion: {
						nodes: [createKafkaTriggerNode('Other Kafka', 'shared-group', 'shared-topic')],
					},
				} as any,
			]);

			await expect(service.validateWorkflowActivation(workflow)).rejects.toThrow(
				TriggerParameterConflictError,
			);
		});

		it('should not throw when only groupId matches but topic is different', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'topic-1'),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue(['workflow-1', 'workflow-2']);
			mockWorkflowRepository.find.mockResolvedValue([
				{
					id: 'workflow-2',
					name: 'Active Workflow',
					activeVersion: {
						nodes: [createKafkaTriggerNode('Other Kafka', 'shared-group', 'topic-2')],
					},
				} as any,
			]);

			await expect(service.validateWorkflowActivation(workflow)).resolves.not.toThrow();
		});

		it('should not throw when both groupId and topic are different from active workflows', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue(['workflow-1', 'workflow-2']);
			mockWorkflowRepository.find.mockResolvedValue([
				{
					id: 'workflow-2',
					name: 'Active Workflow',
					activeVersion: {
						nodes: [createKafkaTriggerNode('Other Kafka', 'group-2', 'topic-2')],
					},
				} as any,
			]);

			await expect(service.validateWorkflowActivation(workflow)).resolves.not.toThrow();
		});

		it('should skip workflows without activeVersion', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'shared-topic'),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue(['workflow-1', 'workflow-2']);
			mockWorkflowRepository.find.mockResolvedValue([
				{
					id: 'workflow-2',
					name: 'Draft Workflow',
					activeVersion: null,
				} as any,
			]);

			await expect(service.validateWorkflowActivation(workflow)).resolves.not.toThrow();
		});

		it('should skip disabled nodes in the workflow being activated', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'shared-group', 'shared-topic', {
					disabled: true,
				}),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue(['workflow-1', 'workflow-2']);

			await service.validateWorkflowActivation(workflow);

			expect(mockWorkflowRepository.find).not.toHaveBeenCalled();
		});

		it('should check multiple active workflows for conflicts', async () => {
			const workflow = createWorkflow('workflow-1', {
				'Kafka Trigger': createKafkaTriggerNode('Kafka Trigger', 'group-1', 'topic-1'),
			});

			mockActiveWorkflows.allActiveWorkflows.mockReturnValue([
				'workflow-1',
				'workflow-2',
				'workflow-3',
			]);
			mockWorkflowRepository.find.mockResolvedValue([
				{
					id: 'workflow-2',
					name: 'Active Workflow 2',
					activeVersion: {
						nodes: [createKafkaTriggerNode('Kafka 2', 'group-2', 'topic-2')],
					},
				} as any,
				{
					id: 'workflow-3',
					name: 'Active Workflow 3',
					activeVersion: {
						nodes: [createKafkaTriggerNode('Kafka 3', 'group-3', 'topic-3')],
					},
				} as any,
			]);

			await expect(service.validateWorkflowActivation(workflow)).resolves.not.toThrow();
			expect(mockWorkflowRepository.find).toHaveBeenCalledTimes(1);
		});
	});
});
