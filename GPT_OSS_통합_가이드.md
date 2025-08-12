# 🚀 GPT OSS를 OKDS AI Assistant에 연결하기

OKDS AI Assistant(Void 기반)에 GPT OSS를 성공적으로 통합했습니다! 이제 여러 방법으로 GPT OSS를 사용할 수 있습니다.

## 📋 연결 방법들

### **방법 1: GPT OSS 전용 프로바이더 사용 (권장)**

새로 추가된 `gptOSS` 프로바이더를 사용하는 방법입니다.

1. **OKDS AI Assistant 설정 열기**
   - 설정 아이콘 클릭 또는 `Cmd/Ctrl + ,`

2. **프로바이더 설정**
   - "Local" 탭에서 "GPT OSS" 선택
   - 다음 정보 입력:
     ```
     Endpoint: http://localhost:8080  (GPT OSS 서버 주소)
     API Key: your-api-key-here      (필요한 경우)
     ```

3. **모델 선택**
   - 기본 모델: `gpt-oss-model`
   - 또는 GPT OSS에서 제공하는 다른 모델명 사용

### **방법 2: OpenAI 호환 프로바이더 사용**

GPT OSS가 OpenAI API 호환 인터페이스를 제공하는 경우:

1. **설정에서 "OpenAI Compatible" 선택**
2. **연결 정보 입력:**
   ```
   Endpoint: http://your-gpt-oss-server:port/v1
   API Key: your-api-key (필요한 경우)
   Headers: {} (추가 헤더가 필요한 경우 JSON 형식)
   ```

## 🔧 GPT OSS 서버 설정

GPT OSS가 다음 형식으로 실행되어야 합니다:

```bash
# 예시: GPT OSS 서버 실행
gpt-oss-server --host 0.0.0.0 --port 8080 --api-version v1
```

## 🛠️ 기능 지원

GPT OSS 통합으로 다음 기능들을 사용할 수 있습니다:

✅ **채팅 (Chat)** - 일반적인 대화형 AI 상호작용
✅ **코드 자동완성 (FIM)** - Fill-in-Middle 방식의 코드 완성
✅ **시스템 메시지** - 컨텍스트 설정 지원
✅ **도구 호출 (Tools)** - OpenAI 스타일 함수 호출
✅ **스트리밍** - 실시간 응답 스트리밍

## 📝 설정 예시

### GPT OSS 전용 설정
```json
{
  "gptOSS": {
    "endpoint": "http://localhost:8080",
    "apiKey": "optional-api-key",
    "selectedModelName": "gpt-oss-model"
  }
}
```

### OpenAI 호환 설정
```json
{
  "openAICompatible": {
    "endpoint": "http://localhost:8080/v1",
    "apiKey": "optional-api-key",
    "headersJSON": "{}",
    "selectedModelName": "your-gpt-oss-model"
  }
}
```

## 🔍 문제 해결

### 연결 문제
- GPT OSS 서버가 실행 중인지 확인
- 포트가 올바른지 확인 (기본값: 8080)
- 방화벽 설정 확인

### API 호환성 문제
- GPT OSS가 OpenAI API v1 호환인지 확인
- 엔드포인트 URL 형식이 올바른지 확인
- 필요한 경우 API 키 설정

### 모델 인식 문제
- GPT OSS에서 제공하는 정확한 모델명 사용
- `/v1/models` 엔드포인트로 사용 가능한 모델 목록 확인

## 🎯 다음 단계

1. **모델 정보 업데이트**: `src/vs/workbench/contrib/void/common/modelCapabilities.ts`에서 실제 GPT OSS 모델 정보로 업데이트
2. **컨텍스트 윈도우 조정**: GPT OSS의 실제 토큰 제한에 맞게 `contextWindow` 값 수정
3. **추가 기능**: 특별한 기능이 있다면 `specialToolFormat` 등 설정 조정

## 📚 관련 파일들

수정된 주요 파일들:
- `src/vs/workbench/contrib/void/common/modelCapabilities.ts` - 프로바이더 설정
- `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts` - 타입 정의
- `src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts` - 구현 로직

---

🎉 **축하합니다!** GPT OSS가 성공적으로 통합되었습니다. 이제 로컬에서 실행되는 GPT OSS를 통해 AI 코딩 어시스턴트를 사용할 수 있습니다.
