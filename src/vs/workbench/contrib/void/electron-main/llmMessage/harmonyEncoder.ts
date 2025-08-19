/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Harmony Encoder - TypeScript implementation based on OpenAI Harmony library
 * GitHub: https://github.com/openai/harmony
 */

import { ChatMode } from '../../common/voidSettingsTypes.js';
import { InternalToolInfo, availableTools } from '../../common/prompt/prompts.js';

// Harmony 특수 토큰들
export const HARMONY_TOKENS = {
	START: '<|start|>',
	END: '<|end|>',
	MESSAGE: '<|message|>',
	CHANNEL: '<|channel|>',
	CONSTRAIN: '<|constrain|>',
	RETURN: '<|return|>',
	CALL: '<|call|>'
} as const;

// Harmony 메시지 타입 정의
export interface HarmonyMessage {
	role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
	content: string;
	channel?: 'analysis' | 'commentary' | 'final';
	recipient?: string;
	contentType?: 'json' | 'text';
}

// 파싱된 Harmony 응답 타입
export interface ParsedHarmonyResponse {
	messages: Array<{
		role: string;
		channel?: string;
		recipient?: string;
		content: string;
		contentType?: string;
	}>;
	stopToken?: '<|return|>' | '<|call|>';
	reasoning: string;
	finalResponse: string;
	toolCalls: Array<{
		name: string;
		params: any;
	}>;
}

/**
 * Harmony 인코더 클래스
 * OpenAI Harmony 라이브러리의 핵심 로직을 TypeScript로 구현
 */
export class HarmonyEncoder {
	/**
	 * 여러 메시지를 Harmony 형식으로 렌더링
	 */
	static renderConversation(messages: HarmonyMessage[]): string {
		return messages.map(msg => this.renderMessage(msg)).join('');
	}

	/**
	 * 단일 메시지를 Harmony 형식으로 렌더링
	 */
	static renderMessage(msg: HarmonyMessage): string {
		let result = `${HARMONY_TOKENS.START}${msg.role}`;

		// 채널 정보 추가
		if (msg.channel) {
			result += `${HARMONY_TOKENS.CHANNEL}${msg.channel}`;
		}

		// 수신자 정보 추가 (도구 호출용)
		if (msg.recipient) {
			result += ` to=${msg.recipient}`;
		}

		// 콘텐츠 타입 제약 조건 추가
		if (msg.contentType) {
			result += ` ${HARMONY_TOKENS.CONSTRAIN}${msg.contentType}`;
		}

		// 메시지 내용과 종료 토큰
		result += `${HARMONY_TOKENS.MESSAGE}${msg.content}${HARMONY_TOKENS.END}`;

		return result;
	}

	/**
	 * Void의 도구 정의를 Harmony TypeScript namespace 형식으로 변환
	 */
	static convertVoidToolsToHarmonyFormat(chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined): string {
		if (!chatMode || chatMode === 'normal') return '';

		const tools = availableTools(chatMode, mcpTools);
		if (!tools || !Array.isArray(tools) || tools.length === 0) return '';

		const toolDefinitions = tools.map(tool => {
			const { name, description, params } = tool;

			if (!params || Object.keys(params).length === 0) {
				return `// ${description}\ntype ${name} = () => any;`;
			}

			const paramDefinitions = Object.entries(params).map(([key, param]) => {
				const optional = (param as any).required === false ? '?' : '';
				const paramDescription = (param as any).description ? `// ${(param as any).description}` : '';
				let type = 'any';

				// 타입 매핑
				if ((param as any).type === 'string') type = 'string';
				else if ((param as any).type === 'number') type = 'number';
				else if ((param as any).type === 'boolean') type = 'boolean';
				else if ((param as any).enum) type = (param as any).enum.map((v: any) => `"${v}"`).join(' | ');

				return `${paramDescription ? paramDescription + '\n' : ''}${key}${optional}: ${type}`;
			}).join(',\n');

			return `// ${description}\ntype ${name} = (_: {\n${paramDefinitions}\n}) => any;`;
		});

		return `namespace functions {\n\n${toolDefinitions.join('\n\n')}\n\n} // namespace functions`;
	}

	/**
	 * Harmony 시스템 메시지 생성
	 */
	static createSystemMessage(chatMode: ChatMode | null): string {
		const currentDate = new Date().toISOString().split('T')[0];

		return `You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: ${currentDate}

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
${chatMode === 'agent' ? `Calls to these tools must go to the commentary channel: 'functions'.` : ''}`;
	}

	/**
	 * Harmony Developer 메시지 생성 (도구 정의 포함)
	 */
	static createDeveloperMessage(
		instructions: string,
		chatMode: ChatMode | null,
		mcpTools: InternalToolInfo[] | undefined
	): string {
		let message = `# Instructions

${instructions}`;

		const toolDefinitions = this.convertVoidToolsToHarmonyFormat(chatMode, mcpTools);
		if (toolDefinitions) {
			message += `\n\n# Tools

## functions

${toolDefinitions}`;
		}

		return message;
	}

	/**
	 * Harmony 응답 부분 파싱 (스트리밍용)
	 * 완성되지 않은 응답도 가능한 한 파싱하여 실시간 표시
	 */
	static parsePartialResponse(response: string): ParsedHarmonyResponse {
		const messages: ParsedHarmonyResponse['messages'] = [];
		let stopToken: ParsedHarmonyResponse['stopToken'];

		// 완성된 메시지만 파싱 (미완성 메시지는 무시)
		const completeMessageRegex = /<\|start\|>(\w+)(?:<\|channel\|>(\w+))?(?:\s+to=([\w.]+))?(?:\s+<\|constrain\|>(\w+))?<\|message\|>(.*?)<\|end\|>/gs;

		let match;
		while ((match = completeMessageRegex.exec(response)) !== null) {
			const [, role, channel, recipient, contentType, content] = match;

			messages.push({
				role,
				channel,
				recipient,
				content: content.trim(),
				contentType
			});
		}

		// Stop token 확인
		if (response.includes('<|return|>')) {
			stopToken = '<|return|>';
		} else if (response.includes('<|call|>')) {
			stopToken = '<|call|>';
		}

		// 채널별 내용 분리
		const reasoning = messages
			.filter(msg => msg.channel === 'analysis')
			.map(msg => msg.content)
			.join('\n');

		const finalResponse = messages
			.filter(msg => msg.channel === 'final')
			.map(msg => msg.content)
			.join('\n');

		const toolCalls = messages
			.filter(msg => msg.channel === 'commentary' && msg.recipient?.startsWith('functions.'))
			.map(msg => {
				try {
					return {
						name: msg.recipient!.replace('functions.', ''),
						params: msg.contentType === 'json' ? JSON.parse(msg.content) : {}
					};
				} catch (e) {
					return {
						name: msg.recipient!.replace('functions.', ''),
						params: {}
					};
				}
			});

		return {
			messages,
			stopToken,
			reasoning,
			finalResponse,
			toolCalls
		};
	}

	/**
	 * Harmony 응답 파싱
	 * 원본 라이브러리와 동일한 방식으로 메시지를 파싱
	 */
	static parseResponse(response: string): ParsedHarmonyResponse {
		const messages: ParsedHarmonyResponse['messages'] = [];
		let stopToken: ParsedHarmonyResponse['stopToken'];

		// 정규표현식으로 메시지 파싱
		const messageRegex = /<\|start\|>(\w+)(?:<\|channel\|>(\w+))?(?:\s+to=([\w.]+))?(?:\s+<\|constrain\|>(\w+))?<\|message\|>(.*?)(?=<\|end\|>|<\|return\|>|<\|call\|>|$)/gs;

		let match;
		while ((match = messageRegex.exec(response)) !== null) {
			const [, role, channel, recipient, contentType, content] = match;

			messages.push({
				role,
				channel,
				recipient,
				content: content.trim(),
				contentType
			});
		}

		// Stop token 확인
		if (response.includes('<|return|>')) {
			stopToken = '<|return|>';
		} else if (response.includes('<|call|>')) {
			stopToken = '<|call|>';
		}

		// 채널별 내용 분리
		const reasoning = messages
			.filter(msg => msg.channel === 'analysis')
			.map(msg => msg.content)
			.join('\n');

		const finalResponse = messages
			.filter(msg => msg.channel === 'final')
			.map(msg => msg.content)
			.join('\n');

		const toolCalls = messages
			.filter(msg => msg.channel === 'commentary' && msg.recipient?.startsWith('functions.'))
			.map(msg => {
				try {
					return {
						name: msg.recipient!.replace('functions.', ''),
						params: msg.contentType === 'json' ? JSON.parse(msg.content) : {}
					};
				} catch (e) {
					// JSON 파싱 실패 시 빈 객체 반환
					return {
						name: msg.recipient!.replace('functions.', ''),
						params: {}
					};
				}
			});

		return {
			messages,
			stopToken,
			reasoning,
			finalResponse,
			toolCalls
		};
	}

	/**
	 * 기존 LLM 메시지를 Harmony 형식으로 변환
	 */
	static convertLLMMessagesToHarmony(messages: any[]): HarmonyMessage[] {
		return messages.map(msg => {
			const harmonyMsg: HarmonyMessage = {
				role: msg.role === 'assistant' ? 'assistant' :
					msg.role === 'user' ? 'user' :
						msg.role === 'tool' ? 'tool' : 'user',
				content: this.extractContentFromMessage(msg)
			};

			// Assistant 메시지의 경우 기본적으로 final 채널로 설정
			if (msg.role === 'assistant') {
				harmonyMsg.channel = 'final';
			}

			return harmonyMsg;
		});
	}

	/**
	 * 메시지에서 텍스트 내용 추출
	 */
	private static extractContentFromMessage(msg: any): string {
		if (typeof msg.content === 'string') {
			return msg.content;
		}

		// Gemini 스타일 메시지 처리
		if ('parts' in msg && Array.isArray(msg.parts)) {
			return msg.parts
				.map((part: any) => 'text' in part ? part.text : '')
				.join('');
		}

		return '';
	}
}
