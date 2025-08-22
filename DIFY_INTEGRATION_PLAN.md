# Dify RAG 통합 작업 계획서

## 🎯 목표
금융 프로젝트(4GB, 수십만 파일)에서 효율적인 코드 검색을 위해 Dify Vector DB를 활용한 하이브리드 검색 구현

## 📊 현황 분석

### 현재 상황
- **문제점**: ripgrep 검색시 rg.exe 프로세스 수백개 생성
- **보유 자산**: 
  - Dify에 메소드 단위로 임베딩된 Vector DB
  - Python으로 파싱된 메소드 메타데이터
  - 기존 `search_for_files` function calling
- **프로젝트 특성**:
  - BXM Framework 사용
  - 주요 파일: `.java`, `.dbio`, `.xml`
  - 모듈 구조: AC, DP, LN 등

### 접근 방법 결정
**✅ 선택: 기존 `search_for_files` 함수 확장**

이유:
1. LLM이 이미 이 함수를 "검색"으로 인식
2. 별도 함수 생성시 LLM이 선택에 혼란
3. 자동으로 최적 검색 방법 선택 가능

## 🔄 프로세스 플로우

```
사용자 검색 요청
    ↓
[search_for_files 호출]
    ↓
검색 쿼리 분석
    ↓
┌─────────────────┐
│ 쿼리 타입 판단  │
└─────────────────┘
    ├─ 클래스/메소드명 검색 → Dify Vector 검색
    ├─ 일반 텍스트 검색 → Hybrid (Dify + ripgrep)
    └─ 파일명 검색 → 기존 ripgrep
```

## 📝 작업 단계

### Phase 1: 분석 및 설계 (함께 작업)
- [x] 1.1 기존 `search_for_files` 함수 분석
  - 현재 구조: 파라미터 검증 → searchService.textSearch → 페이지네이션
  - Java 검색시 `**/*.java`만 포함 (개선 필요: `.dbio`, `.xml` 추가)
  - 단순 키워드 매칭으로 검색 타입 판단
- [x] 1.2 Dify API 스펙 확인
  - Void에 Dify 프로바이더 설정 발견 (`modelCapabilities.ts`)
  - endpoint: `http://ok-ai.okfngroup.com`
  - apiKey: Bearer 토큰 형식
  - 모델명: `dify-workflow`
  - 아직 실제 구현은 없음 (OpenAI Compatible로 처리될 가능성)
- [x] 1.3 검색 쿼리 타입 분류 로직 설계
  - **클래스/메소드명 검색**: CamelCase, PascalCase, `get/set`으로 시작
  - **비즈니스 로직 검색**: "대출", "심사", "계산" 등 한글 포함
  - **파일명 검색**: 확장자 포함 (`.java`, `.dbio`, `.xml`)
  - **일반 텍스트**: 그 외 모든 경우

### Phase 2: 기본 통합 (함께 작업)
- [x] 2.1 Dify Helper 함수 생성
  - `searchWithDify()` 함수 구현 ✅
  - SSE 스트리밍 파싱 로직 ✅
  - 에러 핸들링 및 재시도 로직 ✅
- [x] 2.2 `search_for_files` 수정
  - 쿼리 타입 분석 로직 추가 ✅
  - Dify 호출 통합 ✅
  - `.dbio`, `.xml` 파일 포함하도록 수정 ✅
- [x] 2.3 결과 변환 및 병합
  - Dify 응답을 ripgrep 형식으로 변환 ✅
  - 중복 제거 로직 ✅
  - 우선순위 기반 정렬 (Dify 우선) ✅

### Phase 3: 최적화 (함께 작업)
- [ ] 3.1 캐싱 메커니즘 추가
- [ ] 3.2 폴백 처리 (Dify 실패시 ripgrep)
- [ ] 3.3 성능 모니터링 로그 추가

### Phase 4: 테스트 및 튜닝
- [ ] 4.1 다양한 검색 케이스 테스트
- [ ] 4.2 성능 측정 및 비교
- [ ] 4.3 파라미터 최적화

## 💡 구현 전략

### `search_for_files` 수정 방향

```typescript
// 기존 구조 유지하면서 확장
search_for_files: async (params) => {
    const { query, ... } = params;
    
    // 1. 쿼리 타입 분석
    const queryType = analyzeQueryType(query);
    
    // 2. 검색 전략 선택
    if (queryType === 'className' || queryType === 'methodName') {
        // Dify Vector 검색 우선
        const difyResults = await searchWithDify(query);
        
        if (difyResults.length > 0) {
            // Dify 결과를 ripgrep 형식으로 변환
            return convertToRipgrepFormat(difyResults);
        }
    }
    
    // 3. 폴백 또는 하이브리드
    return existingRipgrepSearch(params);
}
```

### 쿼리 타입 분석 함수

```typescript
function analyzeQueryType(query: string): 'className' | 'methodName' | 'businessLogic' | 'fileName' | 'general' {
    // 파일명 검색 (확장자 포함)
    if (query.match(/\.(java|dbio|xml)$/)) {
        return 'fileName';
    }
    
    // 한글 포함 - 비즈니스 로직 검색
    if (/[가-힣]/.test(query)) {
        return 'businessLogic';
    }
    
    // 메소드명 패턴 (get/set/is로 시작, camelCase)
    if (/^(get|set|is|has|add|remove|update|delete|find|search)[A-Z]/.test(query)) {
        return 'methodName';
    }
    
    // 클래스명 패턴 (PascalCase, Service/DAO/VO/DTO 등으로 끝남)
    if (/^[A-Z][a-zA-Z0-9]*(Service|DAO|VO|DTO|Controller|Manager|Handler|Helper|Util)$/.test(query)) {
        return 'className';
    }
    
    // PascalCase 일반
    if (/^[A-Z][a-z][a-zA-Z0-9]*$/.test(query)) {
        return 'className';
    }
    
    return 'general';
}
```

### Dify 호출 Helper 함수

```typescript
async function searchWithDify(query: string, queryType: string): Promise<URI[]> {
    const settings = voidSettingsService.state.settingsOfProvider.dify;
    
    if (!settings.apiKey) {
        console.log('Dify API key not configured, falling back to ripgrep');
        return [];
    }
    
    const requestBody = {
        query: query,
        inputs: {
            bGubun: "Search",
            search_type: queryType,
            file_type: "java,dbio,xml",  // 모든 타입 포함
            query_embedding: true,
            return_count: 20,
            similarity_threshold: 0.7
        },
        response_mode: "streaming",
        user: `void_${os.hostname()}`
    };
    
    try {
        const response = await fetch('http://ok-ai.okfngroup.com/v1/chat-messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        
        // SSE 스트림 파싱
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        const results: URI[] = [];
        
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.event === 'workflow_finished' && data.data?.outputs?.answer) {
                        // 파싱된 파일 경로들을 URI로 변환
                        const paths = parseFilePathsFromAnswer(data.data.outputs.answer);
                        paths.forEach(path => {
                            results.push(URI.file(path));
                        });
                    }
                }
            }
        }
        
        return results;
        
    } catch (error) {
        console.error('Dify search failed:', error);
        return [];
    }
}

// 응답에서 파일 경로 추출
function parseFilePathsFromAnswer(answer: string): string[] {
    // Dify 응답 형식에 따라 파싱 로직 조정 필요
    const paths: string[] = [];
    const lines = answer.split('\n');
    
    for (const line of lines) {
        // 예: "/src/main/java/com/example/Service.java:42"
        const match = line.match(/^([^:]+\.(java|dbio|xml))(?::\d+)?/);
        if (match) {
            paths.push(match[1]);
        }
    }
    
    return paths;
}
```

## 🤔 결정 사항

### Q1: Dify 통합 위치
**A: 기존 `search_for_files` 내부에 통합**
- 장점: LLM이 자동으로 활용
- 단점: 함수가 복잡해짐
- 해결: 내부 헬퍼 함수로 분리

### Q2: 결과 포맷
**A: 기존 ripgrep 포맷 유지**
- LLM이 기대하는 형식 유지
- 내부적으로만 Dify 활용

### Q3: 성능 vs 정확도
**A: 하이브리드 접근**
- 먼저 Dify로 빠르게 필터링
- 필요시 ripgrep으로 정확한 위치

## 📈 예상 효과

| 지표 | 현재 | 개선 후 | 개선율 |
|------|------|---------|--------|
| 검색 시간 | 30초+ | 3초 | 90% ↓ |
| rg.exe 프로세스 | 수백개 | 10개 이하 | 95% ↓ |
| 검색 정확도 | 높음 | 매우 높음 | 20% ↑ |
| 메모리 사용 | 높음 | 낮음 | 70% ↓ |

## 📚 Dify API 상세 스펙

### Dify Chat Messages API (실제 사용 중)
```typescript
// Dify 설정 (modelCapabilities.ts에서 발견)
dify: {
    endpoint: 'http://ok-ai.okfngroup.com/v1/chat-messages',
    apiKey: '', // Bearer 토큰
}

// API 호출 형식 (Java 코드에서 확인)
POST http://ok-ai.okfngroup.com/v1/chat-messages
Headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Void-Assistant/1.0'
}

// 요청 Body
{
    "query": "검색할 메소드명 또는 클래스명",  // 사용자 입력
    "inputs": {
        "bGubun": "Search",  // 작업 구분 (Search, Edit 등)
        "file_type": "java",  // 파일 타입 (java, dbio, xml)
        "module": "LN"  // 모듈명 (AC, DP, LN 등)
    },
    "conversation_id": "",  // 대화 ID (선택)
    "response_mode": "streaming",  // 응답 모드
    "user": "192.168.1.1_hostname"  // IP_호스트명
}

// 스트리밍 응답 형식 (SSE)
data: {
    "event": "agent_message" | "message" | "workflow_finished",
    "conversation_id": "uuid-string",
    "answer": "검색 결과 또는 응답 텍스트",
    "data": {
        "outputs": {
            "answer": "최종 응답"
        }
    }
}
```

### Vector DB 검색용 입력 형식
```typescript
// 코드 검색을 위한 특별한 inputs
{
    "inputs": {
        "search_type": "method" | "class" | "business_logic",
        "query_embedding": true,  // 벡터 검색 활성화
        "return_count": 10,  // 반환할 결과 수
        "similarity_threshold": 0.7  // 유사도 임계값
    }
}
```

## ✅ 구현 완료 사항

### 구현된 파일
- **C:\dsCodeAssistant\src\vs\workbench\contrib\void\browser\toolsService.ts**
  - `analyzeQueryType()`: 쿼리 타입 자동 분류
  - `searchWithDify()`: Dify API 호출 및 SSE 스트림 처리
  - `parseFilePathsFromAnswer()`: 응답에서 파일 경로 추출
  - `search_for_files()` 수정: Dify + ripgrep 하이브리드 검색

### 주요 기능
1. **쿼리 타입 자동 분류**
   - 클래스명 (PascalCase, Service/DAO 등)
   - 메소드명 (get/set/is 패턴)
   - 비즈니스 로직 (한글 포함)
   - 파일명 (확장자 포함)

2. **Dify Vector 검색**
   - 메소드/클래스명 검색시 우선 실행
   - SSE 스트리밍 응답 처리
   - 5개 이상 결과시 즉시 반환

3. **Ripgrep 폴백**
   - Dify 실패시 자동 폴백
   - `.java`, `.dbio`, `.xml` 모두 검색
   - 30초 타임아웃 설정

4. **결과 병합**
   - Dify 결과 우선 표시
   - 중복 제거
   - 페이지네이션 지원

## 🧪 테스트 방법

### 1. Dify API 키 설정
1. Void 설정 열기 (Ctrl+Shift+P → "Void: Settings")
2. Dify 프로바이더 선택
3. API Key 입력

### 2. 테스트 케이스
```
# 클래스명 검색
"LoanService"  → Dify Vector 검색 실행

# 메소드명 검색  
"getLoanAmount"  → Dify Vector 검색 실행

# 한글 비즈니스 로직
"대출 심사"  → Dify Vector 검색 실행

# 파일명 검색
"loan.dbio"  → 파일명 직접 검색

# 일반 텍스트
"TODO"  → ripgrep 검색
```

### 3. 콘솔 로그 확인
- F12 (개발자 도구) 열기
- Console 탭에서 확인:
  - `[Search]` - 검색 타입 및 전략
  - `[Dify]` - Dify API 호출 상태
  - 결과 개수 및 소스

## 🚀 다음 단계

1. **완료**: Phase 1 - 분석 및 설계 ✅
2. **완료**: Phase 2 - 기본 통합 ✅
3. **다음**: Phase 3 - 테스트 및 최적화

---

## 👥 협업 방식

- **내가 하는 것**: 코드 분석, 구조 제안, 샘플 코드
- **당신이 하는 것**: 요구사항 명확화, 테스트, 피드백
- **함께 하는 것**: 설계 결정, 코드 리뷰, 최적화

준비되면 Phase 1.1부터 시작합시다!