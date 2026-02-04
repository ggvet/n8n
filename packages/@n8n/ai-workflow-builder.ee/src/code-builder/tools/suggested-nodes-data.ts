/**
 * Data for get_suggested_nodes tool.
 * Contains curated node recommendations organized by workflow technique category.
 */

export interface CategorySuggestedNode {
	name: string;
	note?: string;
}

export interface CategoryData {
	description: string;
	patternHint: string;
	nodes: CategorySuggestedNode[];
}

export const suggestedNodesData: Record<string, CategoryData> = {
	chatbot: {
		description: 'Receiving chat messages and replying (built-in chat, Telegram, Slack, etc.)',
		patternHint: 'Chat Trigger → AI Agent → Memory → Response',
		nodes: [
			{
				name: '@n8n/n8n-nodes-langchain.chatTrigger',
				note: 'For production deployments, consider platform triggers (Slack, Telegram) over built-in chat',
			},
			{
				name: '@n8n/n8n-nodes-langchain.agent',
				note: 'For multi-turn conversations, connect memory to maintain context',
			},
			{ name: '@n8n/n8n-nodes-langchain.lmChatOpenAi' },
			{ name: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini' },
			{
				name: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
				note: 'Maintains short-term conversation history',
			},
			{ name: 'n8n-nodes-base.slack', note: 'Use same platform for trigger and response' },
			{ name: 'n8n-nodes-base.telegram', note: 'Use same platform for trigger and response' },
			{ name: 'n8n-nodes-base.whatsApp' },
			{ name: 'n8n-nodes-base.discord' },
		],
	},

	notification: {
		description: 'Sending alerts or updates via email, chat, SMS when events occur',
		patternHint: 'Trigger → Condition → Send (Email/Slack/SMS)',
		nodes: [
			{ name: 'n8n-nodes-base.webhook', note: 'Event-based notifications from external systems' },
			{
				name: 'n8n-nodes-base.scheduleTrigger',
				note: 'Periodic monitoring and batch notifications',
			},
			{ name: 'n8n-nodes-base.gmail', note: 'Easy OAuth setup for sending emails' },
			{ name: 'n8n-nodes-base.slack', note: 'Use channel IDs (starting with C), not names' },
			{ name: 'n8n-nodes-base.telegram', note: 'Use chat ID for direct messages' },
			{ name: 'n8n-nodes-base.twilio', note: 'Use international format (+1234567890)' },
			{
				name: 'n8n-nodes-base.httpRequest',
				note: 'For services without dedicated nodes (Teams, Discord)',
			},
			{ name: 'n8n-nodes-base.if', note: 'Check alert conditions before sending' },
			{
				name: 'n8n-nodes-base.switch',
				note: 'If routing by severity/type is needed, use Switch to direct to different channels',
			},
		],
	},

	scheduling: {
		description: 'Running actions at specific times or intervals',
		patternHint: 'Schedule Trigger → Fetch → Process → Act',
		nodes: [
			{ name: 'n8n-nodes-base.scheduleTrigger' },
			{ name: 'n8n-nodes-base.httpRequest' },
			{ name: 'n8n-nodes-base.if' },
			{ name: 'n8n-nodes-base.set' },
			{ name: 'n8n-nodes-base.wait', note: 'Respect rate limits between API calls' },
		],
	},

	data_transformation: {
		description: 'Cleaning, formatting, or restructuring data',
		patternHint: 'Input → Filter/Map → Transform → Output',
		nodes: [
			{ name: 'n8n-nodes-base.set', note: '"Keep Only Set" drops fields not explicitly defined' },
			{ name: 'n8n-nodes-base.if', note: 'Use early to validate inputs' },
			{ name: 'n8n-nodes-base.filter', note: 'Use early to reduce data volume' },
			{ name: 'n8n-nodes-base.merge', note: 'Normalize field names with Set before merging' },
			{ name: 'n8n-nodes-base.code', note: 'Must return [{json: {...}}] format' },
			{ name: 'n8n-nodes-base.summarize', note: 'Pivot table-style aggregations' },
			{ name: 'n8n-nodes-base.aggregate', note: 'Combine multiple items into one' },
			{
				name: 'n8n-nodes-base.splitOut',
				note: 'Convert single item with array into multiple items',
			},
			{ name: 'n8n-nodes-base.sort' },
			{ name: 'n8n-nodes-base.limit' },
			{ name: 'n8n-nodes-base.removeDuplicates' },
			{
				name: 'n8n-nodes-base.splitInBatches',
				note: 'For large datasets (100+ items), batch processing prevents timeouts',
			},
		],
	},

	data_persistence: {
		description: 'Storing, updating, or retrieving records from persistent storage',
		patternHint: 'Trigger → Process → Store (DataTable/Sheets)',
		nodes: [
			{ name: 'n8n-nodes-base.dataTable', note: 'PREFERRED - no external config needed' },
			{
				name: 'n8n-nodes-base.googleSheets',
				note: 'For collaboration needs; if >10k rows expected, consider DataTable instead',
			},
			{
				name: 'n8n-nodes-base.airtable',
				note: 'If relationships between tables are needed, Airtable supports them',
			},
			{ name: 'n8n-nodes-base.postgres' },
			{ name: 'n8n-nodes-base.mySql' },
			{ name: 'n8n-nodes-base.mongoDb' },
		],
	},

	data_extraction: {
		description: 'Pulling specific information from structured or unstructured inputs',
		patternHint: 'Source → Extract → Parse → Structure',
		nodes: [
			{
				name: 'n8n-nodes-base.extractFromFile',
				note: 'For multiple file types, route by file type first with IF/Switch',
			},
			{ name: 'n8n-nodes-base.htmlExtract', note: 'JS-rendered content may be empty' },
			{ name: 'n8n-nodes-base.splitOut', note: 'Use before Loop Over Items for arrays' },
			{
				name: 'n8n-nodes-base.splitInBatches',
				note: 'Process 200 rows at a time for memory',
			},
			{ name: 'n8n-nodes-base.code' },
			{ name: '@n8n/n8n-nodes-langchain.informationExtractor', note: 'For unstructured text' },
			{
				name: '@n8n/n8n-nodes-langchain.chainSummarization',
				note: 'Context window limits may truncate',
			},
		],
	},

	document_processing: {
		description: 'Taking action on content within files (PDFs, Word docs, images)',
		patternHint: 'Trigger → Extract Text → AI Parse → Store',
		nodes: [
			{
				name: 'n8n-nodes-base.gmailTrigger',
				note: 'To access attachments, set Simplify=FALSE and Download Attachments=TRUE',
			},
			{ name: 'n8n-nodes-base.googleDriveTrigger' },
			{
				name: 'n8n-nodes-base.extractFromFile',
				note: 'Different file types require different operations - route accordingly',
			},
			{ name: 'n8n-nodes-base.awsTextract', note: 'For tables and forms in scanned docs' },
			{ name: 'n8n-nodes-base.mindee', note: 'Specialized invoice/receipt parsing' },
			{ name: '@n8n/n8n-nodes-langchain.agent' },
			{
				name: '@n8n/n8n-nodes-langchain.documentDefaultDataLoader',
				note: 'Use Binary data source for files',
			},
			{
				name: '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
				note: 'No external dependencies needed',
			},
			{ name: 'n8n-nodes-base.splitInBatches', note: 'Process 5-10 files at a time' },
		],
	},

	form_input: {
		description: 'Gathering data from users via forms',
		patternHint: 'Form Trigger → Validate → Store → Respond',
		nodes: [
			{ name: 'n8n-nodes-base.formTrigger', note: 'ALWAYS store raw data to persistent storage' },
			{ name: 'n8n-nodes-base.form', note: 'Each node is one page/step' },
			{ name: 'n8n-nodes-base.dataTable', note: 'PREFERRED for form data storage' },
			{ name: 'n8n-nodes-base.googleSheets' },
			{ name: 'n8n-nodes-base.airtable' },
		],
	},

	content_generation: {
		description: 'Creating text, images, audio, or video',
		patternHint: 'Trigger → Generate (Text/Image/Video) → Deliver',
		nodes: [
			{ name: '@n8n/n8n-nodes-langchain.agent', note: 'For text generation' },
			{
				name: '@n8n/n8n-nodes-langchain.openAi',
				note: 'Use for image/video generation. DALL-E, TTS, Sora video generation',
			},
			{ name: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', note: 'Imagen, video generation' },
			{ name: 'n8n-nodes-base.httpRequest', note: 'For APIs without dedicated nodes' },
			{ name: 'n8n-nodes-base.editImage', note: 'Resize, crop, format conversion' },
			{ name: 'n8n-nodes-base.markdown', note: 'Convert to HTML' },
			{ name: 'n8n-nodes-base.facebookGraphApi', note: 'Use binary data, not URLs for uploads' },
			{
				name: 'n8n-nodes-base.wait',
				note: 'Video generation is async, use wait while polling for updated',
			},
		],
	},

	triage: {
		description: 'Classifying data for routing or prioritization',
		patternHint: 'Trigger → Classify → Route → Act',
		nodes: [
			{
				name: '@n8n/n8n-nodes-langchain.textClassifier',
				note: 'Set "When No Clear Match" to Other branch',
			},
			{
				name: '@n8n/n8n-nodes-langchain.agent',
				note: 'For consistent/deterministic classification, use temperature 0-0.2',
			},
		],
	},

	scraping_and_research: {
		description: 'Collecting information from websites or APIs',
		patternHint: 'Trigger → Fetch → Extract → Store',
		nodes: [
			{
				name: 'n8n-nodes-base.dataTable',
				note: 'Use this to store scraped data. Preferred because no external config needed',
			},
			{
				name: 'n8n-nodes-base.phantombuster',
				note: 'Use this for social media requests: LinkedIn, Facebook, Instagram, Twitter, etc.',
			},
			{ name: '@n8n/n8n-nodes-langchain.toolSerpApi', note: 'Give agent web search capability' },
			{
				name: 'n8n-nodes-base.htmlExtract',
				note: 'Use to extract HTML content from http requests. Though, JS-rendered sites may return empty',
			},
			{
				name: 'n8n-nodes-base.splitInBatches',
				note: 'Use to batch the processing of items. General recommendation: 200 rows at a time if processing is fast',
			},
			{ name: 'n8n-nodes-base.wait', note: 'Use this to avoid rate limits (429 errors)' },
			{ name: 'n8n-nodes-base.httpRequest' },
		],
	},
};

export const categoryList = Object.keys(suggestedNodesData);
