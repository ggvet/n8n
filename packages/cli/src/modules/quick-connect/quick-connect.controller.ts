import type { AuthenticatedRequest } from '@n8n/db';
import { Param, Post, RestController } from '@n8n/decorators';

import { QuickConnectService } from './quick-connect.service';

@RestController('/quick-connect')
export class QuickConnectController {
	constructor(private readonly quickConnectService: QuickConnectService) {}

	@Post('/:credentialType')
	async createCredential(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('credentialType') credentialType: string,
	): Promise<{ id: string }> {
		return await this.quickConnectService.createCredential(credentialType, req.user);
	}
}
