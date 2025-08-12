# 🔧 GPT OSS Harmony 프롬프트 수정 가이드

OKDS AI Assistant에서 GPT OSS의 Agent 모드가 제대로 작동하지 않는 문제를 해결하기 위한 완전한 가이드입니다.

## 📋 **문제 분석**

1. **현재 상황**: Chat 모드는 작동하지만 Agent 모드가 작동하지 않음
2. **원인**: GPT OSS는 Harmony response format이 필요하지만 현재 일반 OpenAI 형식을 사용
3. **해결책**: Harmony 형식에 맞는 프롬프트 변환 및 응답 파싱 구현

## 🛠️ **수정 사항**

### **1. Model Capabilities 업데이트**

`src/vs/workbench/contrib/void/common/modelCapabilities.ts`에서 GPT OSS 모델 설정을 업데이트:

```typescript
const gptOSSModelOptions = {
	'gpt-oss-model': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: true,
		supportsSystemMessage: 'separated' as const, // Harmony uses separated system
		specialToolFormat: 'harmony-style' as const, // 새로운 형식
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' }
		} as const,
	},
}
```

### **2. 새로운 Harmony 스타일 추가**

`src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`에서 타입 업데이트:

```typescript
// specialToolFormat 타입에 harmony-style 추가
export type SpecialToolFormat = 'openai-style' | 'anthropic-style' | 'gemini-style' | 'harmony-style'
```

### **3. Message Conversion 업데이트**

`src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`에서 prepareMessages 함수 수정:

```typescript
const prepareMessages = (params: {
	// ... 기존 매개변수
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat

	// GPT OSS Harmony 형식 처리
	if (params.providerName === 'gptOSS' || specialFormat === 'harmony-style') {
		const res = prepareHarmonyMessages(params)
		return res
	}

	// 기존 처리 로직...
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		// ...
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}

// 새로운 Harmony 메시지 준비 함수
const prepareHarmonyMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'harmony-style' | undefined,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: HarmonyLLMMessage[], separateSystemMessage: string | undefined } => {

	// Harmony 형식의 시스템 메시지 생성
	const harmonySystemMessage = createHarmonySystemMessage(params.systemMessage)

	// Developer 메시지 생성 (도구 정의 포함)
	const harmonyDeveloperMessage = createHarmonyDeveloperMessage(params.aiInstructions)

	const harmonyMessages: HarmonyLLMMessage[] = [
		{ role: 'system', content: harmonySystemMessage },
		{ role: 'developer', content: harmonyDeveloperMessage },
		...params.messages.map(convertToHarmonyMessage)
	]

	return { messages: harmonyMessages, separateSystemMessage: undefined }
}
```

### **4. Harmony 메시지 생성 함수들**

```typescript
// 시스템 메시지 생성
const createHarmonySystemMessage = (originalSystemMessage: string): string => {
	return `You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: ${new Date().toISOString().split('T')[0]}

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
Calls to these tools must go to the commentary channel: 'functions'.`
}

// Developer 메시지 생성 (도구 정의 포함)
const createHarmonyDeveloperMessage = (instructions: string): string => {
	let message = `# Instructions

${instructions}`

	// TODO: 도구 정의를 TypeScript namespace 형식으로 변환
	const toolDefinitions = convertXMLToolsToTypeScript()
	if (toolDefinitions) {
		message += `\n\n# Tools

## functions

${toolDefinitions}`
	}

	return message
}

// XML 도구 정의를 TypeScript 형식으로 변환
const convertXMLToolsToTypeScript = (): string => {
	// 예시 변환:
	// <edit_file><path>string</path><content>string</content></edit_file>
	// ↓
	// type edit_file = (_: { path: string, content: string }) => any;

	return `namespace functions {

// Edit a file with new content
type edit_file = (_: {
// Path to the file to edit
path: string,
// New content for the file
content: string,
}) => any;

// Read a file's content
type read_file = (_: {
// Path to the file to read
path: string,
}) => any;

// Run a terminal command
type run_command = (_: {
// Command to run
command: string,
}) => any;

} // namespace functions`
}
```

### **5. GPT OSS 전용 구현**

`src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts`에서:

```typescript
// GPT OSS 전용 채팅 함수
const sendGPTOSSChat = async (params: SendChatParams_Internal) => {
	const { messages, modelName, settingsOfProvider, providerName } = params

	// 1. 메시지를 Harmony 형식으로 변환
	const harmonyMessages = convertToHarmonyFormat(messages)

	// 2. OpenAI 호환 API 호출
	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })

	const options = {
		model: modelName,
		messages: harmonyMessages,
		stream: true,
	}

	// 3. 응답 스트리밍 및 파싱
	const stream = await openai.chat.completions.create(options)
	let fullResponse = ''

	for await (const chunk of stream) {
		const delta = chunk.choices[0]?.delta?.content
		if (delta) {
			fullResponse += delta
			params.onText(delta)
		}
	}

	// 4. Harmony 응답 파싱
	const parsed = parseHarmonyResponse(fullResponse)
	params.onFinalMessage({
		fullText: parsed.final || fullResponse,
		fullReasoning: parsed.reasoning || '',
		anthropicReasoning: null
	})
}

// Harmony 응답 파싱
const parseHarmonyResponse = (response: string) => {
	const result = { reasoning: '', final: '', toolCall: null }

	// Analysis 채널 (추론) 파싱
	const analysisMatch = response.match(/<\|channel\|>analysis<\|message\|>(.*?)(?=<\|end\|>|<\|start\|>|<\|channel\|>)/s)
	if (analysisMatch) {
		result.reasoning = analysisMatch[1].trim()
	}

	// Final 채널 (최종 답변) 파싱
	const finalMatch = response.match(/<\|channel\|>final<\|message\|>(.*?)(?=<\|return\|>|<\|end\|>|$)/s)
	if (finalMatch) {
		result.final = finalMatch[1].trim()
	}

	// Tool call 파싱
	const toolMatch = response.match(/<\|channel\|>commentary to=functions\.(\w+).*?<\|constrain\|>json<\|message\|>(.*?)<\|call\|>/s)
	if (toolMatch) {
		try {
			result.toolCall = {
				name: toolMatch[1],
				params: JSON.parse(toolMatch[2].trim())
			}
		} catch (e) {
			// 파싱 실패 시 무시
		}
	}

	return result
}

// 프로바이더 구현 업데이트
export const sendLLMMessageToProviderImplementation = {
	// ... 기존 구현들
	gptOSS: {
		sendChat: sendGPTOSSChat, // 전용 함수 사용
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
}
```

## 🎯 **테스트 방법**

1. **기본 채팅 테스트**:
   ```
   사용자: "안녕하세요"
   기대 결과: 정상적인 응답 (final 채널 내용만 표시)
   ```

2. **Agent 모드 테스트**:
   ```
   사용자: "README.md 파일을 만들어주세요"
   기대 결과:
   - Analysis 채널에서 계획 수립
   - Commentary 채널에서 도구 호출
   - Final 채널에서 완료 메시지
   ```

3. **추론 출력 확인**:
   - Analysis 채널의 내용이 `fullReasoning`에 저장되는지 확인
   - Final 채널의 내용만 사용자에게 표시되는지 확인

## 🔧 **Harmony 형식 예시**

### 입력 (System Message):
```
<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: 2025-01-17

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
Calls to these tools must go to the commentary channel: 'functions'.<|end|>
```

### 입력 (Developer Message):
```
<|start|>developer<|message|># Instructions

You are an expert coding agent...

# Tools

## functions

namespace functions {

type edit_file = (_: {
path: string,
content: string,
}) => any;

} // namespace functions<|end|>
```

### 출력 예시:
```
<|start|>assistant<|channel|>analysis<|message|>사용자가 README.md 파일을 만들어달라고 요청했습니다. edit_file 도구를 사용해서 파일을 생성해야 합니다.<|end|>
<|start|>assistant<|channel|>commentary to=functions.edit_file<|constrain|>json<|message|>{"path": "README.md", "content": "# My Project\n\nThis is a sample README file."}<|call|>
```

## 📚 **참고 자료**

- [OpenAI Harmony Response Format 문서](https://cookbook.openai.com/articles/openai-harmony)
- [GPT OSS GitHub Repository](https://github.com/openai/gpt-oss)
- [openai-harmony Python 라이브러리](https://pypi.org/project/openai-harmony/)

## ⚠️ **주의사항**

1. **추론 내용 노출 금지**: Analysis 채널의 내용은 사용자에게 직접 표시하지 말 것
2. **도구 호출 처리**: Commentary 채널의 도구 호출을 올바르게 파싱하고 실행
3. **오류 처리**: Harmony 형식 파싱 실패 시 fallback 로직 구현
4. **성능**: 큰 추론 출력으로 인한 지연 최소화

---

이 가이드를 따라 구현하면 GPT OSS의 Agent 모드가 정상적으로 작동하게 됩니다! 🚀
