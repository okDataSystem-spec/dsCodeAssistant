# 🔧 GPT OSS Harmony 구현 개선 가이드

[OpenAI Harmony GitHub 저장소](https://github.com/openai/harmony)를 참고하여 교차검증한 개선된 구현 가이드입니다.

## 📋 **주요 발견사항**

### ✅ **기존 가이드에서 정확했던 부분**
1. Harmony 토큰 구조 (`<|start|>`, `<|end|>`, `<|message|>`, `<|channel|>`)
2. 채널 시스템 (analysis, commentary, final)
3. TypeScript namespace 도구 정의 형식
4. 시스템 메시지 기본 구조

### 🆕 **GitHub 저장소에서 발견한 추가 정보**

## 🛠️ **개선된 구현 방법**

### **1. OpenAI Harmony 라이브러리 활용**

OKDS AI Assistant에서 Python/Rust 라이브러리를 직접 사용할 수는 없지만, 동일한 로직을 JavaScript/TypeScript로 구현할 수 있습니다.

```typescript
// 정확한 Harmony 인코딩 구현
class HarmonyEncoder {
    // Special token IDs from openai-harmony
    private static TOKENS = {
        START: '<|start|>',
        END: '<|end|>',
        MESSAGE: '<|message|>',
        CHANNEL: '<|channel|>',
        CONSTRAIN: '<|constrain|>',
        RETURN: '<|return|>',
        CALL: '<|call|>'
    }

    static renderConversation(messages: HarmonyMessage[]): string {
        return messages.map(msg => this.renderMessage(msg)).join('')
    }

    static renderMessage(msg: HarmonyMessage): string {
        let result = `${this.TOKENS.START}${msg.role}`

        if (msg.channel) {
            result += `${this.TOKENS.CHANNEL}${msg.channel}`
        }

        if (msg.recipient) {
            result += ` to=${msg.recipient}`
        }

        if (msg.contentType) {
            result += ` ${this.TOKENS.CONSTRAIN}${msg.contentType}`
        }

        result += `${this.TOKENS.MESSAGE}${msg.content}${this.TOKENS.END}`

        return result
    }
}
```

### **2. 정확한 도구 정의 변환**

```typescript
const convertVoidToolsToHarmonyFormat = (tools: InternalToolInfo[]): string => {
    const toolDefinitions = tools.map(tool => {
        const { name, description, params } = tool

        if (!params || Object.keys(params).length === 0) {
            return `// ${description}\ntype ${name} = () => any;`
        }

        const paramDefinitions = Object.entries(params).map(([key, param]) => {
            const optional = param.required === false ? '?' : ''
            const description = param.description ? `// ${param.description}` : ''
            let type = 'any'

            // 타입 매핑
            if (param.type === 'string') type = 'string'
            else if (param.type === 'number') type = 'number'
            else if (param.type === 'boolean') type = 'boolean'
            else if (param.enum) type = param.enum.map(v => `"${v}"`).join(' | ')

            return `${description ? description + '\n' : ''}${key}${optional}: ${type}`
        }).join(',\n')

        return `// ${description}\ntype ${name} = (_: {\n${paramDefinitions}\n}) => any;`
    })

    return `namespace functions {\n\n${toolDefinitions.join('\n\n')}\n\n} // namespace functions`
}
```

### **3. 개선된 시스템 메시지 생성**

```typescript
const createOptimizedHarmonySystemMessage = (chatMode: ChatMode | null): string => {
    const currentDate = new Date().toISOString().split('T')[0]

    return `You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: ${currentDate}

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
${chatMode === 'agent' ? `Calls to these tools must go to the commentary channel: 'functions'.` : ''}`
}
```

### **4. 정밀한 응답 파싱**

```typescript
interface HarmonyResponse {
    messages: Array<{
        role: string
        channel?: string
        recipient?: string
        content: string
        contentType?: string
    }>
    stopToken?: '<|return|>' | '<|call|>'
}

const parseHarmonyResponse = (response: string): HarmonyResponse => {
    const messages: HarmonyResponse['messages'] = []
    let stopToken: HarmonyResponse['stopToken']

    // 정규표현식으로 메시지 파싱
    const messageRegex = /<\|start\|>(\w+)(?:<\|channel\|>(\w+))?(?:\s+to=([\w.]+))?(?:\s+<\|constrain\|>(\w+))?<\|message\|>(.*?)(?=<\|end\|>|<\|return\|>|<\|call\|>|$)/gs

    let match
    while ((match = messageRegex.exec(response)) !== null) {
        const [, role, channel, recipient, contentType, content] = match

        messages.push({
            role,
            channel,
            recipient,
            content: content.trim(),
            contentType
        })
    }

    // Stop token 확인
    if (response.includes('<|return|>')) {
        stopToken = '<|return|>'
    } else if (response.includes('<|call|>')) {
        stopToken = '<|call|>'
    }

    return { messages, stopToken }
}
```

### **5. 완전한 GPT OSS 채팅 구현**

```typescript
const sendGPTOSSChatV2 = async (params: SendChatParams_Internal) => {
    const { messages, onText, onFinalMessage, onError, settingsOfProvider,
            modelName, providerName, chatMode, separateSystemMessage, mcpTools } = params

    // 1. Harmony 형식 메시지 생성
    const harmonyMessages: HarmonyMessage[] = [
        {
            role: 'system',
            content: createOptimizedHarmonySystemMessage(chatMode)
        },
        {
            role: 'developer',
            content: createHarmonyDeveloperMessage(separateSystemMessage || '', chatMode, mcpTools)
        }
    ]

    // 2. 기존 메시지를 Harmony 형식으로 변환
    messages.forEach(msg => {
        const harmonyMsg: HarmonyMessage = {
            role: msg.role === 'assistant' ? 'assistant' :
                  msg.role === 'user' ? 'user' : 'tool',
            content: extractContentFromMessage(msg)
        }

        // Assistant 메시지의 경우 적절한 채널 설정
        if (msg.role === 'assistant') {
            harmonyMsg.channel = 'final'  // 기본적으로 final 채널
        }

        harmonyMessages.push(harmonyMsg)
    })

    // 3. 전체 대화를 Harmony 형식으로 렌더링
    const harmonyPrompt = HarmonyEncoder.renderConversation(harmonyMessages)

    // 4. OpenAI 호환 API 호출 (하지만 Harmony 형식으로)
    const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })

    // 5. Raw completion 방식 사용 (chat completion이 아닌)
    const response = await openai.completions.create({
        model: modelName,
        prompt: harmonyPrompt,
        stream: true,
        max_tokens: 4096,
        stop: ['<|return|>', '<|call|>']
    })

    let fullResponse = ''

    for await (const chunk of response) {
        const text = chunk.choices[0]?.text
        if (text) {
            fullResponse += text
            onText(text)  // 실시간 스트리밍
        }
    }

    // 6. Harmony 응답 파싱
    const parsed = parseHarmonyResponse(fullResponse)

    // 7. 채널별 내용 분리
    const analysisContent = parsed.messages
        .filter(msg => msg.channel === 'analysis')
        .map(msg => msg.content)
        .join('\n')

    const finalContent = parsed.messages
        .filter(msg => msg.channel === 'final')
        .map(msg => msg.content)
        .join('\n')

    const toolCalls = parsed.messages
        .filter(msg => msg.channel === 'commentary' && msg.recipient?.startsWith('functions.'))
        .map(msg => ({
            name: msg.recipient!.replace('functions.', ''),
            params: msg.contentType === 'json' ? JSON.parse(msg.content) : {}
        }))

    // 8. 적절한 응답 반환
    if (toolCalls.length > 0) {
        // 도구 호출이 있는 경우
        // TODO: 도구 실행 로직 구현
    } else {
        // 일반 응답
        onFinalMessage({
            fullText: finalContent || fullResponse,
            fullReasoning: analysisContent,
            anthropicReasoning: null
        })
    }
}
```

## 🎯 **실제 적용 단계**

### **1단계: 기본 Harmony 지원**
- `HarmonyEncoder` 클래스 구현
- 시스템/Developer 메시지 생성 함수 구현
- 기본 파싱 로직 구현

### **2단계: 도구 통합**
- XML → TypeScript namespace 변환 완성
- 도구 호출 파싱 및 실행
- Agent 모드 완전 지원

### **3단계: 최적화**
- 성능 최적화
- 오류 처리 강화
- 사용자 경험 개선

## 📚 **참고 자료**

- [OpenAI Harmony GitHub](https://github.com/openai/harmony)
- [Harmony Documentation](https://github.com/openai/harmony/tree/main/docs)
- [Python openai-harmony 라이브러리](https://pypi.org/project/openai-harmony/)

## ⚠️ **중요 주의사항**

1. **Chat Completions API 대신 Completions API 사용**: Harmony는 raw text completion을 기대합니다
2. **정확한 토큰 처리**: 특수 토큰들이 정확히 렌더링되어야 합니다
3. **채널 분리 필수**: analysis 채널 내용은 절대 사용자에게 노출하지 말 것

---

이제 GitHub 저장소 정보를 바탕으로 더 정확하고 완전한 Harmony 구현이 가능합니다! 🚀
