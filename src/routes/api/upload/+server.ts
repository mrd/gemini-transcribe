import { GoogleGenAI } from '@google/genai';
import { file as tempFile, type FileResult } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// Rate limiting disabled for now
// const requests = new Map<string, { count: number; expires: number }>();
// const RATE_LIMIT = 5;
// const DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

async function* streamChunks(asyncGenerator: AsyncIterableIterator<{ text?: string }>) {
	for await (const chunk of asyncGenerator) {
		if (chunk.text) {
			yield chunk.text;
		}
	}
}

async function generateTranscriptWithModel(
	ai: GoogleGenAI,
	modelName: string,
	fileUri: string,
	mimeType: string,
	language: string
) {
	const response = await ai.models.generateContentStream({
		model: modelName,
		contents: [
			{
				role: 'user',
				parts: [
					{
						fileData: {
							mimeType: mimeType,
							fileUri: fileUri
						}
					},
					{
						text: `Generate a transcript in ${language} for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. Respond with the transcript in the form of this JSON schema:
 [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."},{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Has AI has revolutionized the way we live and work?"}]`
					}
				]
			}
		],
		config: {
			safetySettings,
			responseMimeType: 'application/json'
		}
	});

	return response;
}

export async function POST(event) {
	// Rate limiting disabled for now
	// const ip = event.getClientAddress();
	// const now = Date.now();
	// let record = requests.get(ip);

	// if (!record || record.expires < now) {
	// 	record = { count: 0, expires: now + DURATION };
	// 	requests.set(ip, record);
	// }

	// if (record.count >= RATE_LIMIT) {
	// 	return new Response(
	// 		'This free service supports up to 5 requests per user per day. Please try again tomorrow.',
	// 		{ status: 429 }
	// 	);
	// }

	const { request } = event;

	const contentType = request.headers.get('content-type');
	if (!contentType || !contentType.startsWith('multipart/form-data')) {
		return new Response('Expected multipart/form-data', { status: 400 });
	}

	// Reject large uploads
	const contentLength = request.headers.get('content-length');
	const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 512MB
	if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
		return new Response('File too large', { status: 413 });
	}

	// Convert Web ReadableStream to Node Readable
	const nodeReadable = Readable.fromWeb(request.body as import('stream/web').ReadableStream);

	let language = 'English';
	let apiKey: string | null = null;
	let uploadedFilePath: string | null = null;
	let uploadedFileMime: string | undefined;
	let tempFileHandle: FileResult | undefined;

	const busboy = Busboy({
		headers: {
			'content-type': contentType
		}
	});

	let fileUploadPromise: Promise<void> | null = null;

	const parsePromise = new Promise<void>((resolve, reject) => {
		busboy.on('field', (fieldname, value) => {
			if (fieldname === 'language') {
				language = value || 'English';
			}
			if (fieldname === 'apiKey') {
				apiKey = value;
			}
		});

		busboy.on('file', (fieldname, fileStream, info) => {
			// Only handle the 'file' field
			if (fieldname !== 'file') {
				fileStream.resume(); // discard any other file fields
				return;
			}

			fileUploadPromise = (async () => {
				try {
					tempFileHandle = await tempFile({
						postfix: info.filename.includes('.') ? `.${info.filename.split('.').pop()}` : ''
					});
					uploadedFilePath = tempFileHandle.path;
					uploadedFileMime = info.mimeType;

					await pipeline(fileStream, createWriteStream(tempFileHandle.path));
				} catch (err) {
					reject(err);
				}
			})();
		});

		busboy.on('error', (err) => reject(err));
		busboy.on('finish', async () => {
			// Wait for file upload to complete before resolving
			if (fileUploadPromise) {
				await fileUploadPromise;
			}
			resolve();
		});
	});

	nodeReadable.pipe(busboy);

	try {
		await parsePromise;
	} catch (err) {
		console.error('Error parsing multipart body:', err);
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('Error uploading file', { status: 500 });
	}

	if (!uploadedFilePath || !uploadedFileMime) {
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('No file uploaded', { status: 400 });
	}

	if (!apiKey) {
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('API key is required', { status: 400 });
	}

	// Configure proxy if HTTPS_PROXY or HTTP_PROXY environment variable is set
	const proxyUrl = env.HTTPS_PROXY || env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
	const fetchOptions: any = {};

	if (proxyUrl) {
		console.log('Using proxy:', proxyUrl);
		// Support both HTTP/HTTPS and SOCKS5 proxies
		const agent = proxyUrl.startsWith('socks')
			? new SocksProxyAgent(proxyUrl)
			: new HttpsProxyAgent(proxyUrl);
		fetchOptions.agent = agent;
	}

	const ai = new GoogleGenAI({
		apiKey,
		...(Object.keys(fetchOptions).length > 0 ? { fetchOptions } : {})
	});

	let uploadResult;
	try {
		uploadResult = await ai.files.upload({
			file: uploadedFilePath,
			config: {
				mimeType: uploadedFileMime
			}
		});
	} catch (error) {
		console.error(error);
		return new Response('Error uploading file', { status: 500 });
	} finally {
		if (tempFileHandle) {
			tempFileHandle.cleanup();
		}
	}

	try {
		// Poll until the file is processed
		let uploadedFile = await ai.files.get({ name: uploadResult.name! });

		let retries = 0;
		const maxRetries = 3;
		const initialRetryDelay = 1000;

		while (uploadedFile.state === 'PROCESSING') {
			console.log('File is processing... waiting 5 seconds before next poll.');
			await new Promise((resolve) => setTimeout(resolve, 5000));

			try {
				uploadedFile = await ai.files.get({ name: uploadResult.name! });
				retries = 0;
			} catch (error) {
				if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
					retries++;
					if (retries > maxRetries) {
						console.error(`Transcription API failed after ${maxRetries} retries.`, error);
						throw new Error('Transcription API is currently unavailable. Please try again later.');
					}

					const delay = initialRetryDelay * Math.pow(2, retries - 1);
					console.warn(
						`Transcription API error during polling, retrying in ${delay}ms... (Attempt ${retries}/${maxRetries})`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				} else {
					console.error('Unhandled error during file polling:', error);
					throw error;
				}
			}
		}

		if (uploadedFile.state === 'FAILED') {
			console.error('File processing failed for:', uploadedFile);
			return new Response(
				"Unfortunately this file couldn't be processed. The file may be corrupt or in an unsupported format.",
				{ status: 500 }
			);
		}

		if (!uploadedFile.uri) {
			console.error('Uploaded file URI is undefined');
			return new Response('File upload incomplete, URI not available', { status: 500 });
		}

		let result;
		try {
			console.log('Attempting transcription with gemini-2.5-flash');
			result = await generateTranscriptWithModel(
				ai,
				'gemini-2.5-flash',
				uploadedFile.uri,
				uploadedFileMime,
				language
			);
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes('429') ||
					error.message.includes('rate limit') ||
					error.message.includes('503'))
			) {
				console.warn(
					'Primary model unavailable or rate limited, falling back to gemini-2.5-flash-lite-preview'
				);
				result = await generateTranscriptWithModel(
					ai,
					'gemini-2.5-flash-lite-preview-09-2025',
					uploadedFile.uri,
					uploadedFileMime,
					language
				);
			} else {
				throw error;
			}
		}

		// Rate limiting disabled for now
		// record.count++;
		// requests.set(ip, record);

		const nodeStream = Readable.from(streamChunks(result));
		const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

		return new Response(webStream, {
			headers: {
				'Content-Type': 'text/plain',
				'Transfer-Encoding': 'chunked',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (error) {
		console.error('Error during transcription process:', error);
		return new Response(
			'Sorry, something went wrong generating the transcript. Please try again later.',
			{ status: 500 }
		);
	}
}
