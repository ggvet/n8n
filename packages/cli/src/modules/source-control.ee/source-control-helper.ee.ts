import type { SourceControlledFile } from '@n8n/api-types';
import { isContainedWithin, Logger, safeJoinPath } from '@n8n/backend-common';
import type { TagEntity, WorkflowTagMapping } from '@n8n/db';
import { Container } from '@n8n/di';
import { generateKeyPairSync } from 'crypto';
import { accessSync, constants as fsConstants, mkdirSync } from 'fs';
import isEqual from 'lodash/isEqual';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { jsonParse, UserError } from 'n8n-workflow';
import { ok } from 'node:assert/strict';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'path';

import { License } from '@/license';

import {
	SOURCE_CONTROL_FOLDERS_EXPORT_FILE,
	SOURCE_CONTROL_GIT_KEY_COMMENT,
	SOURCE_CONTROL_TAGS_EXPORT_FILE,
	SOURCE_CONTROL_VARIABLES_EXPORT_FILE,
} from './constants';
import type { StatusExportableCredential } from './types/exportable-credential';
import type { ExportedFolders } from './types/exportable-folders';
import type { KeyPair } from './types/key-pair';
import type { KeyPairType } from './types/key-pair-type';
import type { StatusResourceOwner } from './types/resource-owner';
import type { SourceControlWorkflowVersionId } from './types/source-control-workflow-version-id';

/**
 * Checks if a string is an expression containing template syntax (={{ }}).
 */
export function stringContainsExpression(testString: string): boolean {
	return /^=.*\{\{.+\}\}/.test(testString);
}

/**
 * Sanitizes credential data for export: keeps expressions and numbers, removes plain text secrets.
 */
export function sanitizeCredentialData(
	data: ICredentialDataDecryptedObject,
): ICredentialDataDecryptedObject {
	for (const key of Object.keys(data)) {
		const value = data[key];
		if (value === null) {
			delete data[key];
		} else if (typeof value === 'object' && !Array.isArray(value)) {
			data[key] = sanitizeCredentialData(value as ICredentialDataDecryptedObject);
		} else if (typeof value === 'string') {
			data[key] = stringContainsExpression(value) ? value : '';
		}
		// Numbers, booleans, and arrays are kept as-is
	}
	return data;
}

function isPlainObject(value: unknown): value is ICredentialDataDecryptedObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compares two credential data objects using deep equality.
 */
export function hasCredentialDataChanged(
	data1: ICredentialDataDecryptedObject | undefined,
	data2: ICredentialDataDecryptedObject | undefined,
): boolean {
	if (!data1 && !data2) return false;
	if (!data1 || !data2) return true;
	return !isEqual(data1, data2);
}

/**
 * Merges remote credential data into local data.
 * Remote expressions overwrite local values; empty strings are ignored (preserves local secrets).
 */
export function mergeCredentialData(
	local: ICredentialDataDecryptedObject,
	remote: ICredentialDataDecryptedObject,
): ICredentialDataDecryptedObject {
	const merged = { ...local };

	for (const key of Object.keys(remote)) {
		const remoteValue = remote[key];

		if (typeof remoteValue === 'string') {
			if (stringContainsExpression(remoteValue)) {
				merged[key] = remoteValue;
			}
			// Empty string = plain value on remote, keep local
		} else if (isPlainObject(remoteValue)) {
			const localValue = local[key];
			if (isPlainObject(localValue)) {
				merged[key] = mergeCredentialData(localValue, remoteValue);
			} else {
				merged[key] = mergeCredentialData({}, remoteValue);
			}
		}
		// Numbers, booleans, arrays from remote are ignored
	}

	return merged;
}

export function getWorkflowExportPath(workflowId: string, workflowExportFolder: string): string {
	return safeJoinPath(workflowExportFolder, `${workflowId}.json`);
}

export function getProjectExportPath(projectId: string, projectExportFolder: string): string {
	return safeJoinPath(projectExportFolder, `${projectId}.json`);
}

export function getCredentialExportPath(
	credentialId: string,
	credentialExportFolder: string,
): string {
	return safeJoinPath(credentialExportFolder, `${credentialId}.json`);
}

export function getVariablesPath(gitFolder: string): string {
	return safeJoinPath(gitFolder, SOURCE_CONTROL_VARIABLES_EXPORT_FILE);
}

export function getTagsPath(gitFolder: string): string {
	return safeJoinPath(gitFolder, SOURCE_CONTROL_TAGS_EXPORT_FILE);
}

export function getFoldersPath(gitFolder: string): string {
	return safeJoinPath(gitFolder, SOURCE_CONTROL_FOLDERS_EXPORT_FILE);
}

export async function readTagAndMappingsFromSourceControlFile(file: string): Promise<{
	tags: TagEntity[];
	mappings: WorkflowTagMapping[];
}> {
	try {
		return jsonParse<{ tags: TagEntity[]; mappings: WorkflowTagMapping[] }>(
			await fsReadFile(file, { encoding: 'utf8' }),
			{ fallbackValue: { tags: [], mappings: [] } },
		);
	} catch (error) {
		// Return fallback if file not found
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { tags: [], mappings: [] };
		}
		throw error;
	}
}

export async function readFoldersFromSourceControlFile(file: string): Promise<ExportedFolders> {
	try {
		return jsonParse<ExportedFolders>(await fsReadFile(file, { encoding: 'utf8' }), {
			fallbackValue: { folders: [] },
		});
	} catch (error) {
		// Return fallback if file not found
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { folders: [] };
		}
		throw error;
	}
}

export function sourceControlFoldersExistCheck(
	folders: string[],
	createIfNotExists = true,
): boolean {
	// running these file access function synchronously to avoid race conditions
	let existed = true;
	folders.forEach((folder) => {
		try {
			accessSync(folder, fsConstants.F_OK);
		} catch {
			existed = false;
			if (createIfNotExists) {
				try {
					mkdirSync(folder, { recursive: true });
				} catch (error) {
					Container.get(Logger).error((error as Error).message);
				}
			}
		}
	});
	return existed;
}

export function isSourceControlLicensed() {
	const license = Container.get(License);
	return license.isSourceControlLicensed();
}

export async function generateSshKeyPair(keyType: KeyPairType) {
	const sshpk = await import('sshpk');
	const keyPair: KeyPair = {
		publicKey: '',
		privateKey: '',
	};
	let generatedKeyPair: KeyPair;
	switch (keyType) {
		case 'ed25519':
			generatedKeyPair = generateKeyPairSync('ed25519', {
				privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
				publicKeyEncoding: { format: 'pem', type: 'spki' },
			});
			break;
		case 'rsa':
			generatedKeyPair = generateKeyPairSync('rsa', {
				modulusLength: 4096,
				publicKeyEncoding: {
					type: 'spki',
					format: 'pem',
				},
				privateKeyEncoding: {
					type: 'pkcs8',
					format: 'pem',
				},
			});
			break;
	}
	const keyPublic = sshpk.parseKey(generatedKeyPair.publicKey, 'pem');
	keyPublic.comment = SOURCE_CONTROL_GIT_KEY_COMMENT;
	keyPair.publicKey = keyPublic.toString('ssh');
	const keyPrivate = sshpk.parsePrivateKey(generatedKeyPair.privateKey, 'pem');
	keyPrivate.comment = SOURCE_CONTROL_GIT_KEY_COMMENT;
	keyPair.privateKey = keyPrivate.toString('ssh-private');
	return {
		privateKey: keyPair.privateKey,
		publicKey: keyPair.publicKey,
	};
}

export function getRepoType(repoUrl: string): 'github' | 'gitlab' | 'other' {
	if (repoUrl.includes('github.com')) {
		return 'github';
	} else if (repoUrl.includes('gitlab.com')) {
		return 'gitlab';
	}
	return 'other';
}

function filterSourceControlledFilesUniqueIds(files: SourceControlledFile[]) {
	return (
		files.filter((file, index, self) => {
			return self.findIndex((f) => f.id === file.id) === index;
		}) || []
	);
}

export function getTrackingInformationFromPullResult(
	userId: string,
	result: SourceControlledFile[],
) {
	const uniques = filterSourceControlledFilesUniqueIds(result);
	return {
		userId,
		credConflicts: uniques.filter(
			(file) =>
				file.type === 'credential' && file.status === 'modified' && file.location === 'local',
		).length,
		workflowConflicts: uniques.filter(
			(file) => file.type === 'workflow' && file.status === 'modified' && file.location === 'local',
		).length,
		workflowUpdates: uniques.filter((file) => file.type === 'workflow').length,
	};
}

export function getTrackingInformationFromPrePushResult(
	userId: string,
	result: SourceControlledFile[],
) {
	const uniques = filterSourceControlledFilesUniqueIds(result);
	return {
		userId,
		workflowsEligible: uniques.filter((file) => file.type === 'workflow').length,
		workflowsEligibleWithConflicts: uniques.filter(
			(file) => file.type === 'workflow' && file.conflict,
		).length,
		credsEligible: uniques.filter((file) => file.type === 'credential').length,
		credsEligibleWithConflicts: uniques.filter(
			(file) => file.type === 'credential' && file.conflict,
		).length,
		variablesEligible: uniques.filter((file) => file.type === 'variables').length,
	};
}

export function getTrackingInformationFromPostPushResult(
	userId: string,
	result: SourceControlledFile[],
) {
	const uniques = filterSourceControlledFilesUniqueIds(result);
	return {
		userId,
		workflowsPushed: uniques.filter((file) => file.pushed && file.type === 'workflow').length ?? 0,
		workflowsEligible: uniques.filter((file) => file.type === 'workflow').length ?? 0,
		credsPushed:
			uniques.filter((file) => file.pushed && file.file.startsWith('credential_stubs')).length ?? 0,
		variablesPushed:
			uniques.filter((file) => file.pushed && file.file.startsWith('variable_stubs')).length ?? 0,
	};
}

/**
 * Normalizes and validates the given source controlled file path. Ensures
 * the path is absolute and contained within the git folder.
 *
 * @throws {UserError} If the path is not within the git folder
 */
export function normalizeAndValidateSourceControlledFilePath(
	gitFolderPath: string,
	filePath: string,
) {
	ok(path.isAbsolute(gitFolderPath), 'gitFolder must be an absolute path');

	const normalizedPath = path.isAbsolute(filePath)
		? filePath
		: safeJoinPath(gitFolderPath, filePath);

	if (!isContainedWithin(gitFolderPath, filePath)) {
		throw new UserError(`File path ${filePath} is invalid`);
	}

	return normalizedPath;
}

export function hasOwnerChanged(
	owner1?: StatusResourceOwner,
	owner2?: StatusResourceOwner,
): boolean {
	// We only compare owners when there is at least one team owner
	// because personal owners projects are not synced with source control
	if (owner1?.type !== 'team' && owner2?.type !== 'team') {
		return false;
	}

	return owner1?.projectId !== owner2?.projectId;
}

/**
 * Checks if a workflow has been modified by comparing version IDs and parent folder IDs
 * between local and remote versions
 */
export function isWorkflowModified(
	local: SourceControlWorkflowVersionId,
	remote: SourceControlWorkflowVersionId,
): boolean {
	const hasVersionIdChanged = remote.versionId !== local.versionId;
	const hasParentFolderIdChanged =
		remote.parentFolderId !== undefined && remote.parentFolderId !== local.parentFolderId;
	const ownerChanged = hasOwnerChanged(remote.owner, local.owner);

	return hasVersionIdChanged || hasParentFolderIdChanged || ownerChanged;
}

export function areSameCredentials(
	credA: StatusExportableCredential,
	credB: StatusExportableCredential,
): boolean {
	return (
		credA.name === credB.name &&
		credA.type === credB.type &&
		!hasOwnerChanged(credA.ownedBy, credB.ownedBy) &&
		Boolean(credA.isGlobal) === Boolean(credB.isGlobal)
	);
}
