import { GoogleGenAI } from '@google/genai';

export async function POST({ request }) {
	try {
		const { transcript, language, apiKey, prompt } = await request.json();

		if (!apiKey) {
			return new Response('API key is required', { status: 400 });
		}

		if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
			return new Response('Transcript is required', { status: 400 });
		}

		if (!prompt) {
			return new Response('Summary prompt is required', { status: 400 });
		}

		const ai = new GoogleGenAI({ apiKey });

		const transcriptText = transcript
			.map((entry) => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
			.join('\n\n');

		const finalPrompt = prompt.replace('{language}', language) + '\n\n' + transcriptText;

		const response = await ai.models.generateContent({
			model: 'gemini-2.5-flash',
			contents: [
				{
					role: 'user',
					parts: [
						{
							text: finalPrompt
						}
					]
				}
			],
			config: {
				responseMimeType: 'text/plain'
			}
		});

		const summary = response.text;

		return new Response(JSON.stringify({ summary }), {
			headers: {
				'Content-Type': 'application/json'
			}
		});
	} catch (error) {
		console.error('Error generating summary:', error);
		if (error instanceof Error) {
			if (error.message.includes('API key') || error.message.includes('authentication')) {
				return new Response('Invalid API key', { status: 401 });
			}
			if (error.message.includes('429') || error.message.includes('rate limit')) {
				return new Response('Rate limit exceeded. Please try again later.', { status: 429 });
			}
		}
		return new Response('Failed to generate summary', { status: 500 });
	}
}